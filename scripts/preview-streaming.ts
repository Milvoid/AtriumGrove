import { mkdtempSync } from "./test-resources.js";
// Isolated, deterministic UI acceptance fixture. No native model runs.
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "../apps/control/src/server.js";
import { ingest } from "../apps/control/src/runtime.js";
import { uuid, now } from "../packages/persistence/src/index.js";
const state = mkdtempSync(join(tmpdir(), "harbor-stream-ui-"));
execFileSync(
  process.execPath,
  ["--import", "tsx", "apps/control/src/cli.ts", "demo", "--state", state],
  { stdio: "pipe" },
);
const {
  app,
  service: s,
  store: db,
} = await createServer(state, { schedule: false });
const url = await app.listen({ host: "127.0.0.1", port: 0 });
const agents = db.all("SELECT * FROM agents ORDER BY name LIMIT 2");
const channel = db.get("SELECT * FROM channels LIMIT 1")!;
const message = s.post(channel.id, {
  blocks: [{ type: "text", text: "检查输入组件与实时执行事件。" }],
  recipientAgentIds: agents.map((a) => a.id),
  requestResponse: true,
  kind: "message",
  clientMessageId: uuid(),
});
const runs = agents.map((agent, index) => {
  const session = uuid(),
    launch = uuid(),
    run = uuid();
  let seq = 0;
  db.run(
    "INSERT INTO agent_sessions(id,agent_id,driver,launch_id,generation,state,workspace_path,config_digest,created_at) VALUES (?,?,?,?,1,'busy',?,'test',?)",
    session,
    agent.id,
    JSON.parse(agent.runtime_json).driver,
    launch,
    state,
    now(),
  );
  db.run(
    "INSERT INTO runs(id,agent_id,session_id,episode_id,primary_message_id,launch_id,state,context_digest) VALUES (?,?,?,?,?,?,'running','test')",
    run,
    agent.id,
    session,
    message.episodeId,
    message.id,
    launch,
  );
  db.run(
    "UPDATE deliveries SET state='sent',run_id=? WHERE message_id=? AND agent_id=? AND reason<>'context'",
    run,
    message.id,
    agent.id,
  );
  s.updated("Run", run, agent.workspace_id);
  return {
    agent,
    run,
    index,
    emit: (body: any) =>
      ingest(s, agent.host_id, {
        ...body,
        launchId: launch,
        producerSeq: ++seq,
        agentId: agent.id,
        sessionId: session,
        runId: run,
        lane: [],
        occurredAt: now(),
      }),
  };
});
const info = { url, state, loginToken: s.auth.nonce() };
writeFileSync("/tmp/harbor-stream-preview.json", JSON.stringify(info), {
  mode: 0o600,
});
console.log(JSON.stringify({ url, state }));
let started = false,
  finished = false;
const timer = setInterval(() => {
  if (!started && existsSync(join(state, "start"))) {
    started = true;
    for (const r of runs) {
      r.emit({ kind: "turn.started", nativeTurnId: "test-" + r.run });
      r.emit({
        kind: "message.delta",
        messageId: "intro",
        blockIndex: 0,
        channel: "commentary",
        text: "正在检查输入组件，",
      });
      setTimeout(() => {
        r.emit({
          kind: "message.delta",
          messageId: "intro",
          blockIndex: 0,
          channel: "commentary",
          text: "接下来运行测试。",
        });
        r.emit({
          kind: "tool.started",
          callId: "read",
          name: "Read",
          input: { file_path: "apps/web/src/main.tsx" },
        });
        r.emit({
          kind: "tool.completed",
          callId: "read",
          outcome: "ok",
          result: "Enter 发送；Shift+Enter 换行；输入法选词不会发送。",
        });
        r.emit({
          kind: "tool.started",
          callId: "test",
          name: "Bash",
          input: { command: "pnpm test", cwd: "/tmp/streaming-check" },
        });
        r.emit({
          kind: "tool.progress",
          callId: "test",
          text: "执行测试中…\n",
        });
      }, 1200);
    }
  }
  if (started && !finished && existsSync(join(state, "finish"))) {
    finished = true;
    for (const r of runs) {
      r.emit({
        kind: "tool.completed",
        callId: "test",
        outcome: r.index ? "error" : "ok",
        result: r.index ? "示例失败：测试夹具路径不存在" : "50 tests passed",
      });
      r.emit({
        kind: "message.completed",
        messageId: "intro",
        channel: "commentary",
        text: "正在检查输入组件，接下来运行测试。",
      });
      r.emit({
        kind: "message.delta",
        messageId: "final",
        blockIndex: 0,
        channel: "final",
        text: "检查完成。",
      });
      r.emit({
        kind: "message.completed",
        messageId: "final",
        channel: "final",
        text: "检查完成。",
      });
      r.emit({
        kind: "turn.terminal",
        outcome: "completed",
        finalText: "检查完成。",
      });
      r.emit({ kind: "resources.quiescent" });
    }
  }
}, 200);
for (const sig of ["SIGINT", "SIGTERM"])
  process.once(sig, () => {
    clearInterval(timer);
    void app.close().then(() => process.exit(0));
  });
