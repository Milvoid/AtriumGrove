import { mkdtempSync } from "./test-resources.js";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSession } from "../packages/runtime-codex/src/index.js";
import { ClaudeSession } from "../packages/runtime-claude/src/index.js";
import { executablePath } from "../packages/runtime-common/src/index.js";
import { sha, uuid } from "../packages/persistence/src/index.js";
import type { SessionSpec, RuntimeEvent } from "../spec/contracts/runtime.js";
const config = JSON.parse(
  readFileSync(join(process.env.HOME!, ".harbor/host/config.json"), "utf8"),
);
const root = mkdtempSync(join(tmpdir(), "harbor-stream-native-"));
writeFileSync(join(root, "sample.txt"), "Streaming verification: 42.\n");
const results: any[] = [];
for (const driver of ["codex-app-server", "claude-code-sdk"] as const) {
  const path = executablePath(
    driver === "codex-app-server" ? config.codexPath : config.claudePath,
  );
  const spec: SessionSpec = {
    agentId: uuid(),
    sessionId: uuid(),
    launchId: uuid(),
    generation: 1,
    driver,
    executable: {
      id: "local",
      realPath: path,
      sha256: sha(readFileSync(path)),
      version: "installed",
      authProfileRef: "local",
    },
    workspacePath: root,
    model: "default",
    permissionProfile: "full-access",
    settingsProfile: "isolated",
    standingInstructions:
      "Only operate in this temporary verification directory. Do not read any other directory. No network or modifications.",
    mcpServers: [],
  };
  const events: RuntimeEvent[] = [];
  let finish!: () => void;
  const end = new Promise<void>((r) => (finish = r));
  const Session = driver === "codex-app-server" ? CodexSession : ClaudeSession;
  const session = new Session(spec, async (e) => {
    events.push(e);
    if (e.kind === "turn.terminal") finish();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await session.initialize();
    await session.submit({
      runId: uuid(),
      inputId: uuid(),
      episodeId: uuid(),
      primaryMessageId: uuid(),
      deliveryIds: [],
      text: "First say briefly what you will do. Then use a read tool or shell command to read sample.txt in the current directory. Finally report the number in it in one short sentence.",
      images: [],
      contextDigest: "stream-test",
      source: "human_dispatch",
    });
    await Promise.race([
      end,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Turn timed out")), 90000);
      }),
    ]);
    const terminal = events.findIndex((e) => e.kind === "turn.terminal");
    results.push({
      driver,
      model: session.nativeModel,
      outcome: "completed",
      textBeforeTerminal: events
        .slice(0, terminal)
        .some((e) => e.kind === "message.delta"),
      toolBeforeTerminal: events
        .slice(0, terminal)
        .some((e) => e.kind === "tool.started"),
      events: events.filter((e) =>
        [
          "message.delta",
          "message.completed",
          "tool.started",
          "tool.progress",
          "tool.completed",
          "turn.terminal",
        ].includes(e.kind),
      ),
    });
  } catch (e) {
    results.push({ driver, error: String(e) });
  } finally {
    clearTimeout(timer);
    if (session instanceof CodexSession && session.nativeSessionId) {
      await session
        .rpc("thread/archive", { threadId: session.nativeSessionId })
        .catch((error) => {
          console.error("Test thread cleanup failed", String(error));
          process.exitCode = 1;
        });
    }
    await session.close();
  }
  console.log(
    driver,
    JSON.stringify({
      textBeforeTerminal: results.at(-1).textBeforeTerminal,
      toolBeforeTerminal: results.at(-1).toolBeforeTerminal,
      error: results.at(-1).error,
    }),
  );
}
writeFileSync(
  "docs/reports/native-streaming.json",
  JSON.stringify(
    { generatedAt: new Date().toISOString(), root, results },
    null,
    2,
  ) + "\n",
);
if (results.some((r) => !r.textBeforeTerminal || !r.toolBeforeTerminal))
  process.exitCode = 1;
