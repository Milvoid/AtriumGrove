import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeTrace,
  projectTrace,
  toolTitle,
  type TraceRecord,
} from "../apps/web/src/activity-model.js";
import {
  tracePreview,
  codexToolInput,
  codexToolResult,
} from "../packages/runtime-common/src/telemetry.js";
import { runFixture } from "./helpers.js";
import { ingest } from "../apps/control/src/runtime.js";
import { execute } from "../apps/control/src/api.js";
const event = (
  producerSeq: number,
  payload: any,
  lane: string[] = [],
): TraceRecord => ({
  id: String(producerSeq),
  launchId: "launch",
  producerSeq,
  runId: "run",
  occurredAt: "2026-10-09T00:00:00Z",
  lane,
  kind: payload.kind,
  payload,
});
test("Live text, block ordering, child lanes and tool input updates survive replay without duplication", () => {
  const records = [
    event(1, {
      kind: "message.delta",
      messageId: "m",
      blockIndex: 0,
      text: "开始",
    }),
    event(2, { kind: "tool.started", callId: "t", name: "Read", input: {} }),
    event(3, {
      kind: "tool.started",
      callId: "t",
      name: "Read",
      input: { file_path: "src/index.ts" },
    }),
    event(4, {
      kind: "message.delta",
      messageId: "m",
      blockIndex: 1,
      text: "检查",
    }),
    event(5, {
      kind: "message.delta",
      messageId: "m",
      blockIndex: 0,
      text: "工作",
    }),
    event(
      6,
      { kind: "message.delta", messageId: "m", blockIndex: 0, text: "子任务" },
      ["child"],
    ),
    event(7, { kind: "tool.progress", callId: "t", text: "partial output" }),
  ];
  const state = projectTrace(mergeTrace(records.slice(3), records));
  assert.equal(state.items[0]!.text, "开始工作\n\n检查");
  assert.equal(state.items.length, 3);
  assert.equal(state.terminal, undefined);
  assert.equal(toolTitle(state.items[1]!), "读取文件 · src/index.ts");
  const complete = projectTrace(
    mergeTrace(records, [
      event(8, {
        kind: "message.completed",
        messageId: "m",
        channel: "final",
        text: "完整结论",
      }),
      event(9, {
        kind: "tool.completed",
        callId: "t",
        outcome: "error",
        result: "file missing",
      }),
    ]),
  );
  assert.equal(complete.items[0]!.text, "完整结论");
  assert.equal(complete.items[1]!.outcome, "error");
  assert.equal(complete.items[1]!.result, "file missing");
});
test("Persisted live trace is available before terminal, paginates beyond 200, and channel filters bind cursors", () => {
  const f = runFixture();
  try {
    for (let seq = 1; seq <= 405; seq++)
      ingest(
        f.s,
        f.host,
        f.event(
          {
            kind: "message.delta",
            messageId: "m",
            blockIndex: 0,
            channel: "unknown",
            text: String(seq) + ",",
          },
          seq,
        ),
      );
    const p = { workspaceId: f.ws.id };
    const runs = execute(
      f.s,
      "listRuns",
      p,
      {},
      { channelId: f.channel.id, limit: 1 },
    );
    assert.equal(runs.items[0].id, f.run);
    assert.equal(runs.items[0].state, "running");
    const other = f.s.createChannel(f.ws.id, "other");
    assert.equal(
      execute(f.s, "listRuns", p, {}, { channelId: other.id }).items.length,
      0,
    );
    const outside = f.s.createChannel(
      f.s.createWorkspace("outside").id,
      "outside",
    );
    assert.throws(
      () => execute(f.s, "listRuns", p, {}, { channelId: outside.id }),
      /another project/,
    );
    let cursor = null,
      items: TraceRecord[] = [],
      pages = 0;
    do {
      const page = execute(
        f.s,
        "getRunEvents",
        { runId: f.run },
        {},
        { limit: 200, ...(cursor ? { cursor } : {}) },
      );
      items.push(...page.items);
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(items.length, 405);
    assert.equal(
      projectTrace(mergeTrace(items, items.slice(-10))).items[0]!.text,
      Array.from({ length: 405 }, (_, i) => String(i + 1) + ",").join(""),
    );
    assert.equal(
      f.db.get("SELECT count(*) n FROM events WHERE event_type='run.trace'")!.n,
      405,
    );
  } finally {
    f.db.close();
  }
});
test("Tool previews retain commands, paths and output while bounding binary and credential fields", () => {
  assert.deepEqual(
    codexToolInput({
      type: "commandExecution",
      command: "rg hello src",
      cwd: "/tmp/demo",
    }),
    { command: "rg hello src", cwd: "/tmp/demo" },
  );
  assert.deepEqual(
    codexToolResult({
      type: "commandExecution",
      exitCode: 1,
      aggregatedOutput: "no matches",
    }),
    { type: "commandExecution", aggregatedOutput: "no matches", exitCode: 1 },
  );
  const preview = tracePreview({
    api_key: "private",
    content: [
      { type: "image", data: "large" },
      { type: "text", text: "x".repeat(100000) },
    ],
  }) as any;
  assert.equal(preview.api_key, "[redacted]");
  assert.equal(preview.content[0].preview, "[图片]");
  assert.ok(JSON.stringify(preview).length < 34000);
});

test("Queued messages remain visible before a run exists, including lost sessions", async () => {
  const { fixture } = await import("./helpers.js");
  const { pendingActivityLabel } = await import(
    "../apps/web/src/activity-model.js"
  );
  const f = fixture();
  try {
    f.s.post(f.channel.id, f.message([f.agents[0]!.id]));
    f.db.run(
      "UPDATE agents SET observed_state='unknown' WHERE id=?",
      f.agents[0]!.id,
    );
    const pending = f.s.conversationActivity(f.channel.id).items;
    assert.equal(pending.length, 1);
    assert.match(pendingActivityLabel(pending[0]!), /会话连接异常/);
    assert.equal(f.db.get("SELECT count(*) n FROM runs")!.n, 0);
    const other = f.s.createChannel(f.ws.id, "Other");
    assert.equal(f.s.conversationActivity(other.id).items.length, 0);
    assert.match(
      pendingActivityLabel({
        hostState: "online",
        agentState: "starting",
        episodeState: "open",
      }),
      /连接模型/,
    );
  } finally {
    f.db.close();
  }
});
