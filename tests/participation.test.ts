import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, runFixture } from "./helpers.js";
import { execute } from "../apps/control/src/api.js";
import { Scheduler } from "../apps/control/src/runtime.js";
import { collaboration } from "../apps/control/src/collaboration.js";
import { uuid } from "../packages/persistence/src/index.js";

function members(
  f: ReturnType<typeof fixture>,
  channel: string,
  ids: string[],
) {
  return execute(
    f.s,
    "setChannelMembers",
    { channelId: channel },
    {
      expectedVersion: f.db.entity("channels", channel).version,
      agentIds: ids,
    },
  );
}

test("Participation alone does not launch a process; an addressed message automatically opens the member without global start", () => {
  const f = fixture();
  try {
    f.s.connectedHosts.add(f.host);
    const scheduler = new Scheduler(f.s);
    scheduler.tick();
    assert.equal(f.db.get("SELECT count(*) n FROM agent_sessions")!.n, 0);
    const a = f.agents[0]!;
    assert.equal(a.desiredState, "stopped");
    f.s.post(f.channel.id, f.message([a.id]));
    scheduler.tick();
    assert.equal(f.db.get("SELECT count(*) n FROM agent_sessions")!.n, 1);
    const session = f.db.get("SELECT * FROM agent_sessions")!;
    f.db.run("UPDATE agent_sessions SET state='ready' WHERE id=?", session.id);
    scheduler.tick();
    assert.equal(f.db.get("SELECT count(*) n FROM runs")!.n, 1);
  } finally {
    f.db.close();
  }
});

test("Removal cancels only this conversation's pending work; rejoining never replays it and another conversation still executes", () => {
  const f = fixture();
  try {
    const a = f.agents[0]!;
    const other = execute(
      f.s,
      "createChannel",
      { workspaceId: f.ws.id },
      { name: "second", agentIds: [a.id] },
    );
    const first = f.s.post(f.channel.id, f.message([a.id]));
    const second = f.s.post(other.id, {
      ...f.message([a.id]),
      threadId: undefined,
    });
    members(f, f.channel.id, []);
    assert.equal(
      f.db.get("SELECT state FROM deliveries WHERE message_id=?", first.id)!
        .state,
      "cancelled",
    );
    assert.equal(
      f.db.get("SELECT state FROM deliveries WHERE message_id=?", second.id)!
        .state,
      "pending",
    );
    // A late peer answer or task notification must not queue fresh work after removal.
    f.s.delivery(first.id, a.id, "requested_reply");
    assert.equal(
      f.db.get("SELECT state FROM deliveries WHERE message_id=?", first.id)!
        .state,
      "cancelled",
    );
    members(f, f.channel.id, [a.id]);
    f.s.connectedHosts.add(f.host);
    const scheduler = new Scheduler(f.s);
    scheduler.tick();
    f.db.run("UPDATE agent_sessions SET state='ready'");
    scheduler.tick();
    assert.equal(
      f.db.get("SELECT primary_message_id FROM runs")!.primary_message_id,
      second.id,
    );
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM host_commands WHERE kind='runtime.close'",
      )!.n,
      0,
    );
  } finally {
    f.db.close();
  }
});

test("Removing a working member lets its current answer finish without closing its session mid-turn", () => {
  const f = runFixture();
  try {
    members(f, f.channel.id, []);
    f.s.connectedHosts.add(f.host);
    new Scheduler(f.s).tick();
    assert.equal(f.db.entity("runs", f.run).state, "running");
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM host_commands WHERE kind='runtime.close'",
      )!.n,
      0,
    );
    const answer = collaboration(
      f.s,
      {
        workspaceId: f.ws.id,
        agentId: f.agent.id,
        sessionId: f.session,
        launchId: f.launch,
        runId: f.run,
        capabilities: [],
        channelIds: [],
      },
      "collab_post",
      {
        channelId: f.channel.id,
        threadId: f.thread,
        replyToMessageId: f.db.entity("runs", f.run).primary_message_id,
        text: "Finished the existing turn",
        recipients: [],
        requestResponse: false,
        kind: "answer",
        requestKey: uuid(),
      },
    );
    assert.ok(answer);
    f.db.run("UPDATE runs SET state='completed' WHERE id=?", f.run);
    f.db.run("UPDATE agent_sessions SET state='ready' WHERE id=?", f.session);
    new Scheduler(f.s).tick();
    new Scheduler(f.s).tick();
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM host_commands WHERE kind='runtime.close'",
      )!.n,
      1,
    );
  } finally {
    f.db.close();
  }
});

test("Idle preset edits close the old process once and hold queued work until it is closed; busy edits are rejected", () => {
  const f = fixture();
  try {
    const a = f.agents[0]!;
    f.s.connectedHosts.add(f.host);
    f.s.post(f.channel.id, f.message([a.id]));
    const scheduler = new Scheduler(f.s);
    scheduler.tick();
    f.db.run("UPDATE agent_sessions SET state='ready'");
    f.db.run("UPDATE agents SET observed_state='idle' WHERE id=?", a.id);
    execute(
      f.s,
      "patchAgent",
      { agentId: a.id },
      { expectedVersion: a.version, name: "Updated preset" },
    );
    scheduler.tick();
    assert.equal(f.db.get("SELECT count(*) n FROM runs")!.n, 0);
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM host_commands WHERE kind='runtime.close'",
      )!.n,
      1,
    );
    assert.equal(f.s.get("Agent", a.id).name, "Updated preset");
    f.db.run("UPDATE agent_sessions SET state='closed'");
    scheduler.tick();
    f.db.run("UPDATE agent_sessions SET state='ready' WHERE state='opening'");
    scheduler.tick();
    assert.equal(f.db.get("SELECT count(*) n FROM runs")!.n, 1);
    assert.throws(
      () =>
        execute(
          f.s,
          "patchAgent",
          { agentId: a.id },
          { expectedVersion: 2, name: "Busy" },
        ),
      /本轮完成/,
    );
  } finally {
    f.db.close();
  }
});

test("Creation validates participants before creating a conversation; stale membership versions cannot overwrite changes; unhealthy runtimes do not relaunch", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        execute(
          f.s,
          "controlAgent",
          { agentId: f.agents[0]!.id },
          {
            expectedVersion: f.agents[0]!.version,
            action: "start",
          },
        ),
      /请在对话中选择参与成员/,
    );
    const count = f.db.get("SELECT count(*) n FROM channels")!.n;
    assert.throws(() =>
      execute(
        f.s,
        "createChannel",
        { workspaceId: f.ws.id },
        { name: "invalid", agentIds: [uuid()] },
      ),
    );
    assert.equal(f.db.get("SELECT count(*) n FROM channels")!.n, count);
    members(f, f.channel.id, [f.agents[0]!.id]);
    assert.throws(() =>
      execute(
        f.s,
        "setChannelMembers",
        { channelId: f.channel.id },
        { expectedVersion: 1, agentIds: [] },
      ),
    );
    f.s.post(f.channel.id, f.message([f.agents[0]!.id]));
    f.db.run("UPDATE agents SET observed_state='unknown'");
    f.s.connectedHosts.add(f.host);
    new Scheduler(f.s).tick();
    assert.equal(f.db.get("SELECT count(*) n FROM agent_sessions")!.n, 0);
  } finally {
    f.db.close();
  }
});
