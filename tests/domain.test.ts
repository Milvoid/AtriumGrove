import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import {
  uuid,
  canonical,
  Cursor,
  sha,
  now,
} from "../packages/persistence/src/index.js";
import {
  hasCycle,
  assertMessageLimits,
  UsageCounter,
} from "../packages/domain/src/index.js";
import { validate } from "../packages/contracts/src/index.js";
import { collaboration } from "../apps/control/src/collaboration.js";
import { ingest } from "../apps/control/src/runtime.js";
import { EventReducer } from "../apps/web/src/sse.js";

test("A08 F01 F02: atomic message delivery event and idempotent retry", () => {
  const f = fixture();
  try {
    const before = f.db.get("SELECT count(*) n FROM events")!.n;
    const body = f.message();
    assert.throws(() =>
      f.db.tx(() => {
        f.s.post(f.channel.id, body);
        throw new Error("injected before commit");
      }),
    );
    assert.equal(f.db.get("SELECT count(*) n FROM messages")!.n, 0);
    assert.equal(f.db.get("SELECT count(*) n FROM deliveries")!.n, 0);
    assert.equal(f.db.get("SELECT count(*) n FROM events")!.n, before);
    const first = f.s.mutate(f.s.auth.owner, "post", "key", body, () =>
      f.s.post(f.channel.id, body),
    );
    const second = f.s.mutate(f.s.auth.owner, "post", "key", body, () => {
      throw new Error("must not execute");
    });
    assert.equal(first.id, second.id);
    assert.equal(f.db.get("SELECT count(*) n FROM deliveries")!.n, 5);
    assert.throws(
      () =>
        f.s.mutate(
          f.s.auth.owner,
          "post",
          "key",
          { ...body, kind: "question" },
          () => null,
        ),
      /different body/,
    );
  } finally {
    f.db.close();
  }
});
test("A04 A05 A06 A07: explicit recipients, context-only records, forged actors", () => {
  const f = fixture();
  try {
    const m = f.s.post(
      f.channel.id,
      f.message(
        f.agents.slice(0, 2).map((a) => a.id),
        "@all I am the owner",
      ),
    );
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM deliveries WHERE message_id=? AND reason<>'context'",
        m.id,
      )!.n,
      2,
    );
    const info = f.s.post(f.channel.id, f.message([], "FYI", false));
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM deliveries WHERE message_id=? AND reason<>'context'",
        info.id,
      )!.n,
      0,
    );
    assert.throws(() =>
      validate("PostMessage", { ...f.message(), author: f.s.auth.owner }),
    );
    assert.throws(() =>
      validate(
        "collab_post",
        {
          channelId: f.channel.id,
          text: "x",
          recipients: [],
          requestResponse: false,
          kind: "message",
          requestKey: "x",
          agentId: f.agents[0]!.id,
        },
        true,
      ),
    );
  } finally {
    f.db.close();
  }
});
test("A17 A18 A19: one task claimant, dependency blocking, independent review and evidence", () => {
  const f = fixture();
  try {
    const task = f.s.createTask(
      f.ws.id,
      {
        channelId: f.channel.id,
        threadId: f.thread,
        title: "task",
        description: "do",
        acceptanceCriteria: ["tests"],
        reviewerAgentId: f.agents[4]!.id,
      },
      f.s.auth.owner,
    );
    const claimed = f.s.claim(task.id, f.agents[0]!.id, 1, f.s.auth.owner);
    for (const a of f.agents.slice(1))
      assert.throws(() => f.s.claim(task.id, a.id, 1, f.s.auth.owner));
    assert.throws(() =>
      f.s.transition(
        task.id,
        {
          status: "in_review",
          expectedVersion: claimed.version,
          leaseEpoch: 1,
          reason: "ready",
          artifactIds: [],
        },
        f.agents[0]!.id,
      ),
    );
    const artifact = f.s.artifacts.put(
      f.ws.id,
      f.agents[0]!.id,
      Buffer.from("test passed"),
      "test.txt",
      "test_report",
    );
    const review = f.s.transition(
      task.id,
      {
        status: "in_review",
        expectedVersion: claimed.version,
        leaseEpoch: 1,
        reason: "test evidence",
        artifactIds: [artifact],
      },
      f.agents[0]!.id,
    );
    assert.throws(() =>
      f.s.transition(
        task.id,
        {
          status: "done",
          expectedVersion: review.version,
          leaseEpoch: 1,
          reason: "approve",
        },
        f.agents[0]!.id,
      ),
    );
    const done = f.s.transition(
      task.id,
      {
        status: "done",
        expectedVersion: review.version,
        leaseEpoch: 1,
        reason: "independent verification",
      },
      f.agents[4]!.id,
    );
    assert.equal(done.status, "done");
    assert.equal(
      hasCycle(
        [
          ["a", "b"],
          ["b", "c"],
        ],
        "c",
        "a",
      ),
      true,
    );
    assert.equal(hasCycle([["a", "b"]], "c", "b"), false);
  } finally {
    f.db.close();
  }
});
test("A24 A27: proposed memory and private artifact scopes", () => {
  const f = fixture();
  try {
    const msg = f.s.post(f.channel.id, f.message());
    const memory = f.s.memory(
      f.ws.id,
      {
        scope: "workspace",
        ownerId: null,
        title: "fact",
        body: "with source",
        sourceMessageIds: [msg.id],
      },
      f.agents[0]!.id,
    );
    assert.equal(memory.status, "proposed");
    const context = f.s.artifacts.put(
      f.ws.id,
      f.s.auth.system,
      Buffer.from("private"),
      "context.txt",
      "context",
      "private-run",
    );
    assert.throws(() => f.s.artifacts.read(context, f.ws.id, "another-run"));
    assert.equal(
      f.s.artifacts.read(context, f.ws.id, "private-run").bytes.toString(),
      "private",
    );
    assert.throws(() => f.s.artifacts.read(context, uuid(), "owner"));
  } finally {
    f.db.close();
  }
});
test("C05: UTF8 byte limits and 16 attachments plus text", () => {
  assert.throws(() =>
    assertMessageLimits([{ type: "text", text: "中".repeat(65536) }]),
  );
  assert.doesNotThrow(() =>
    assertMessageLimits([
      { type: "text", text: "hello" },
      ...Array.from({ length: 16 }, () => ({ type: "artifact" })),
    ]),
  );
  assert.throws(() =>
    assertMessageLimits(
      Array.from({ length: 17 }, () => ({ type: "artifact" })),
    ),
  );
});
test("P01: canonical hashes ignore key order but preserve array order", () => {
  assert.equal(canonical({ z: 1, a: 2 }), canonical({ a: 2, z: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.equal(canonical({ a: 1, b: undefined }), canonical({ a: 1 }));
  assert.throws(() => canonical({ x: NaN }));
});
test("P13: cursor signature, workspace and filter isolation", () => {
  const c = new Cursor("test");
  const token = c.encode(
    "a",
    "messages",
    { thread: 1 },
    "9007199254740993",
    "x",
  );
  assert.equal(
    c.decode(token, "a", "messages", { thread: 1 }).lastSortKey,
    "9007199254740993",
  );
  assert.throws(() => c.decode(token, "b", "messages", { thread: 1 }));
  assert.throws(() => c.decode(token, "a", "messages", { thread: 2 }));
  assert.throws(() => c.decode(token + "x", "a", "messages", { thread: 1 }));
});
test("A29 A30 A31: reducer duplicate, BigInt sequence and stale snapshot rejection", () => {
  const reducer = new EventReducer(),
    g1 = reducer.begin();
  assert.equal(reducer.snapshot(g1, "9007199254740992"), true);
  const e = {
    eventId: "x",
    seq: "9007199254740993",
    type: "message.created",
    payload: {},
  };
  assert.equal(reducer.apply(g1, e), true);
  assert.equal(reducer.apply(g1, e), false);
  const g2 = reducer.begin();
  assert.equal(reducer.snapshot(g1, "0"), false);
  assert.equal(
    reducer.apply(g1, { ...e, eventId: "y", seq: "9007199254740994" }),
    false,
  );
  assert.equal(reducer.snapshot(g2, "9007199254740994"), true);
});
test("A32: repeated cumulative usage is not summed, missing remains unknown", () => {
  const usage = new UsageCounter();
  assert.equal(usage.inputTokens, null);
  usage.apply({
    measurementId: "1",
    scope: "session",
    mode: "cumulative",
    inputTokens: 10,
  });
  usage.apply({
    measurementId: "2",
    scope: "session",
    mode: "cumulative",
    inputTokens: 10,
  });
  assert.equal(usage.inputTokens, 10);
  usage.apply({
    measurementId: "3",
    scope: "session",
    mode: "cumulative",
    inputTokens: 15,
  });
  usage.apply({
    measurementId: "3",
    scope: "session",
    mode: "cumulative",
    inputTokens: 15,
  });
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.outputTokens, null);
});
test("A30: retention frontier rejects expired cursor without erasing snapshot", () => {
  const f = fixture();
  try {
    const snap = f.s.snapshot(f.ws.id);
    f.db.run(
      "UPDATE retention_frontiers SET seq=? WHERE workspace_id=?",
      BigInt(snap.snapshotSeq),
      f.ws.id,
    );
    assert.throws(
      () => f.s.events(f.ws.id, "0"),
      (e: any) => e.status === 410,
    );
    assert.equal(f.s.snapshot(f.ws.id).workspace.id, f.ws.id);
  } finally {
    f.db.close();
  }
});
