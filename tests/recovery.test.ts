import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, runFixture } from "./helpers.js";
import {
  uuid,
  now,
  sha,
  canonical,
} from "../packages/persistence/src/index.js";
import { ingest } from "../apps/control/src/runtime.js";
import { reconcileHost, maintain } from "../apps/control/src/recovery.js";
import { Host } from "../apps/host/src/host.js";
import { validateFrame } from "../packages/contracts/src/index.js";
import { validateNativeRequest } from "../packages/runtime-codex/src/schema.js";

test("F05 F08: persisted event retransmission is idempotent; gaps and conflicting sequence fail", () => {
  const f = runFixture();
  try {
    const event = f.event(
      {
        kind: "message.delta",
        messageId: "m",
        blockIndex: 0,
        channel: "final",
        text: "one",
      },
      1,
    );
    ingest(f.s, f.host, event);
    const before = f.db.get("SELECT count(*) n FROM events")!.n;
    ingest(f.s, f.host, event);
    assert.equal(f.db.get("SELECT count(*) n FROM events")!.n, before);
    assert.throws(
      () => ingest(f.s, f.host, { ...event, producerSeq: 3 }),
      /Expected producer sequence/,
    );
    assert.throws(
      () => ingest(f.s, f.host, { ...event, text: "different" }),
      /Conflicting/,
    );
    assert.equal(f.db.get("SELECT count(*) n FROM runtime_events")!.n, 1);
  } finally {
    f.db.close();
  }
});

test("F03 F04: lost receipt returns saved result; issuing uncertainty never invokes native code again", async () => {
  const f = fixture(),
    host = new Host({
      hostId: f.host,
      credential: f.credential,
      stateDir: f.dir,
      controllerUrl: "http://127.0.0.1:1",
      mode: "fake",
      codexPath: process.execPath,
      claudePath: process.execPath,
    });
  const internal = host as any;
  internal.epoch = uuid();
  let calls = 0;
  internal.execute = async () => {
    calls++;
    return { status: "accepted" };
  };
  const command = {
    schemaVersion: 1,
    commandId: uuid(),
    controllerEpoch: internal.epoch,
    hostId: f.host,
    issuedAt: now(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    kind: "runtime.submit",
    payload: { runId: uuid() },
    payloadHash: "",
  };
  command.payloadHash = sha(canonical(command.payload));
  try {
    await internal.command(command);
    await internal.command(command);
    assert.equal(calls, 1);
    assert.throws(() =>
      validateFrame({
        schemaVersion: 1,
        type: "command",
        command: { ...command, payloadHash: "bad" },
      }),
    );
    const uncertain = { ...command, commandId: uuid() };
    host.db.run(
      "INSERT INTO received_commands VALUES (?,?,'unknown',?,NULL,NULL,?)",
      uncertain.commandId,
      uncertain.payloadHash,
      JSON.stringify(uncertain),
      now(),
    );
    await internal.command(uncertain);
    assert.equal(calls, 1);
    await assert.rejects(
      internal.command({ ...command, payloadHash: "a".repeat(64) }),
      /changed/,
    );
  } finally {
    host.db.close();
    f.db.close();
  }
});

test("F06: controller reconnect retains live session; missing process is unknown and paused", () => {
  const f = runFixture();
  try {
    reconcileHost(f.s, f.host, [
      {
        launchId: f.launch,
        sessionId: f.session,
        runId: f.run,
        nativeSessionId: "native",
        state: "busy",
      },
    ]);
    assert.equal(f.db.entity("runs", f.run).state, "running");
    reconcileHost(f.s, f.host, []);
    assert.equal(f.db.entity("runs", f.run).state, "unknown");
    assert.equal(f.db.entity("agents", f.agent.id).desired_state, "paused");
  } finally {
    f.db.close();
  }
});

test("A10: only root final is published and long output has a complete artifact", () => {
  const f = runFixture();
  try {
    const text = "界".repeat(30000);
    ingest(
      f.s,
      f.host,
      f.event(
        {
          kind: "message.completed",
          messageId: "commentary",
          channel: "commentary",
          text: "private progress",
        },
        1,
      ),
    );
    ingest(f.s, f.host, {
      ...f.event(
        {
          kind: "message.completed",
          messageId: "child",
          channel: "final",
          text: "child must not be canonical",
        },
        2,
      ),
      lane: ["child"],
    });
    ingest(
      f.s,
      f.host,
      f.event(
        {
          kind: "message.completed",
          messageId: "root",
          channel: "final",
          text,
        },
        3,
      ),
    );
    ingest(
      f.s,
      f.host,
      f.event({ kind: "turn.terminal", outcome: "completed" }, 4),
    );
    assert.equal(f.db.entity("runs", f.run).state, "draining");
    ingest(f.s, f.host, f.event({ kind: "resources.quiescent" }, 5));
    const answer = f.s.get(
      "Message",
      f.db.entity("runs", f.run).final_message_id,
    );
    assert.equal(answer.blocks.length, 2);
    assert.equal(
      f.s.artifacts.read(answer.blocks[1].artifactId, f.ws.id).bytes.toString(),
      text,
    );
    assert.equal(f.db.entity("runs", f.run).state, "completed");
  } finally {
    f.db.close();
  }
});

test("A20: expired task lease blocks while retaining its owner", () => {
  const f = fixture();
  try {
    const task = f.s.createTask(
      f.ws.id,
      {
        channelId: f.channel.id,
        threadId: f.thread,
        title: "t",
        description: "d",
        acceptanceCriteria: ["evidence"],
      },
      f.s.auth.owner,
    );
    f.s.claim(task.id, f.agents[0]!.id, 1, f.s.auth.owner);
    f.db.run("UPDATE tasks SET lease_expires_ms=0 WHERE id=?", task.id);
    maintain(f.s);
    const current = f.s.get("Task", task.id);
    assert.equal(current.status, "blocked");
    assert.equal(current.assigneeAgentId, f.agents[0]!.id);
    assert.throws(
      () =>
        f.s.claim(task.id, f.agents[1]!.id, current.version, f.s.auth.owner),
      /owned/,
    );
  } finally {
    f.db.close();
  }
});

test("P01 A29: SQLite sequence beyond 2^53 survives snapshot and replay", () => {
  const f = fixture();
  try {
    f.db.run(
      "UPDATE sqlite_sequence SET seq=? WHERE name='events'",
      9007199254740995n,
    );
    f.s.post(f.channel.id, f.message([], "large sequence", false));
    const snapshot = f.s.snapshot(f.ws.id);
    assert.ok(BigInt(snapshot.snapshotSeq) > 9007199254740995n);
    const events = f.s.events(f.ws.id, "9007199254740995");
    assert.equal(events[0]!.seq, "9007199254740996");
  } finally {
    f.db.close();
  }
});

test("A41: pinned native schema rejects incorrect enum spelling", () => {
  validateNativeRequest("thread/start", {
    approvalPolicy: "untrusted",
    sandbox: "read-only",
  });
  assert.throws(
    () =>
      validateNativeRequest("thread/start", {
        approvalPolicy: "unlessTrusted",
        sandbox: "readOnly",
      }),
    /allowed values|schema/,
  );
});

test("Confirmed idle shutdown is recoverable; active turn uncertainty is never retried", () => {
  const f = runFixture();
  try {
    const run = f.db.get("SELECT * FROM runs LIMIT 1")!;
    const session = f.db.entity("agent_sessions", run.session_id);
    reconcileHost(f.s, f.host, [
      { launchId: session.launch_id, state: "closed" },
    ]);
    assert.equal(f.db.entity("runs", run.id).state, "unknown");
    f.db.run("UPDATE runs SET state='completed' WHERE id=?", run.id);
    reconcileHost(f.s, f.host, [
      { launchId: session.launch_id, state: "closed" },
    ]);
    assert.equal(f.db.entity("agent_sessions", session.id).state, "closed");
    assert.equal(
      f.db.entity("agents", session.agent_id).observed_state,
      "stopped",
    );
  } finally {
    f.db.close();
  }
});
