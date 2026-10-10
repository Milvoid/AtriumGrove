import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, runFixture } from "./helpers.js";
import { execute } from "../apps/control/src/api.js";
import { Scheduler } from "../apps/control/src/runtime.js";
import { uuid, now } from "../packages/persistence/src/index.js";

function remove(f: ReturnType<typeof fixture>, agent = f.agents[0]!) {
  return f.s.mutate(
    f.s.auth.owner,
    `DELETE /agents/${agent.id}`,
    uuid(),
    { expectedVersion: agent.version },
    () =>
      execute(
        f.s,
        "deleteAgent",
        { agentId: agent.id },
        { expectedVersion: agent.version },
      ),
  );
}

test("deleting a member withdraws participation and pending work, preserves history and frees its name", () => {
  const f = fixture(),
    a = f.agents[0]!;
  try {
    const m = f.s.post(f.channel.id, f.message([a.id]));
    const second = f.s.createChannel(f.ws.id, "second", "", [a.id], f.project);
    const deleted = remove(f);
    assert.equal(deleted.name, a.name);
    assert.equal(
      f.s.snapshot(f.ws.id).agents.some((x: any) => x.id === a.id),
      false,
    );
    assert.equal(
      f.db.get("SELECT 1 FROM channel_members WHERE agent_id=?", a.id),
      undefined,
    );
    assert.equal(
      f.db.entity("channels", second.id).version,
      second.version + 1,
    );
    assert.equal(
      f.db.get(
        "SELECT state FROM deliveries WHERE agent_id=? AND message_id=?",
        a.id,
        m.id,
      )?.state,
      "cancelled",
    );
    assert.equal(f.db.entity("messages", m.id).id, m.id);
    assert.throws(
      () => f.s.createChannel(f.ws.id, "bad", "", [a.id]),
      /已删除/,
    );
    assert.throws(
      () =>
        f.s.setChannelMembers(
          f.channel.id,
          [a.id],
          f.db.entity("channels", f.channel.id).version,
        ),
      /已删除/,
    );
    assert.throws(
      () =>
        execute(
          f.s,
          "patchAgent",
          { agentId: a.id },
          { expectedVersion: deleted.version, name: "revive" },
        ),
      /已删除/,
    );
    const recreated = f.s.createAgent(f.ws.id, { ...a, role: "new preset" });
    assert.equal(recreated.name, a.name);
    assert.notEqual(recreated.id, a.id);
    new Scheduler(f.s).tick();
    assert.equal(
      f.db.get("SELECT 1 FROM runs WHERE agent_id=?", a.id),
      undefined,
    );
    assert.deepEqual(f.db.all("PRAGMA foreign_key_check"), []);
  } finally {
    f.db.close();
  }
});

test("deletion rejects live runs and unfinished task ownership without partial changes", () => {
  const f = runFixture();
  try {
    assert.throws(() => remove(f), /正在执行/);
    assert.equal(f.db.entity("agents", f.agent.id).deleted_at, null);
    assert.ok(
      f.db.get("SELECT 1 FROM channel_members WHERE agent_id=?", f.agent.id),
    );
    f.db.run("UPDATE runs SET state='completed' WHERE id=?", f.run);
    f.db.run("UPDATE agent_sessions SET state='ready' WHERE id=?", f.session);
    const task = f.s.createTask(
      f.ws.id,
      {
        channelId: f.channel.id,
        threadId: f.thread,
        title: "review",
        description: "test",
        acceptanceCriteria: [],
        reviewerAgentId: f.agent.id,
      },
      f.s.auth.owner,
    );
    assert.throws(() => remove(f), /未完成任务/);
    f.db.run("UPDATE tasks SET status='cancelled' WHERE id=?", task.id);
    remove(f);
    assert.equal(f.db.entity("agent_sessions", f.session).state, "recovering");
    assert.ok(
      f.db.get("SELECT 1 FROM host_commands WHERE kind='runtime.close'"),
    );
    assert.equal(f.db.entity("runs", f.run).state, "completed");
  } finally {
    f.db.close();
  }
});

test("deletion rejects stale versions and unsettled sessions", () => {
  const f = fixture(),
    a = f.agents[0]!;
  try {
    assert.throws(
      () => remove(f, { ...a, version: a.version + 1 }),
      /version/i,
    );
    f.db.run(
      "INSERT INTO agent_sessions(id,agent_id,driver,launch_id,generation,state,workspace_path,config_digest,created_at) VALUES (?,?,'codex-app-server',?,1,'opening',?,'test',?)",
      uuid(),
      a.id,
      uuid(),
      f.dir,
      now(),
    );
    assert.throws(() => remove(f), /正在连接或清理/);
    assert.equal(f.db.entity("agents", a.id).deleted_at, null);
  } finally {
    f.db.close();
  }
});
