import { mkdtempSync } from "./test-resources.js";
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodexSession } from "../packages/runtime-codex/src/index.js";
import { ClaudeSession } from "../packages/runtime-claude/src/index.js";
import { sha, uuid } from "../packages/persistence/src/index.js";
import type { RuntimeEvent, SessionSpec } from "../spec/contracts/runtime.js";
const root = mkdtempSync(join(tmpdir(), "harbor-native-"));
execFileSync("git", ["init", "-q", root]);
writeFileSync(
  join(root, "README.md"),
  "Atrium Grove native qualification sandbox. No private data.\n",
);
const results = [];
for (const driver of ["codex-app-server", "claude-code-sdk"] as const) {
  const path = realpathSync(
      execFileSync(
        "which",
        [driver === "codex-app-server" ? "codex" : "claude"],
        { encoding: "utf8" },
      ).trim(),
    ),
    nonce = "HARBOR_" + uuid();
  const events: RuntimeEvent[] = [];
  let finish!: (event: RuntimeEvent) => void;
  const terminal = new Promise<RuntimeEvent>((r) => (finish = r));
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
      version: execFileSync(path, ["--version"], { encoding: "utf8" }).trim(),
      authProfileRef: "local-login",
    },
    workspacePath: root,
    model: "default",
    permissionProfile: "review",
    settingsProfile: "project-reviewed",
    standingInstructions:
      "This is a harmless Atrium Grove qualification probe. Return the exact requested nonce. Do not use tools or read other files.",
    mcpServers: [],
  };
  const onEvent = async (e: RuntimeEvent) => {
    events.push(e);
    if (e.kind === "turn.terminal") finish(e);
    if (e.kind === "approval.requested")
      await session.respond({
        approvalId: e.request.approvalId,
        argumentHash: e.request.argumentHash,
        action: "deny",
        expectedVersion: 1,
      });
  };
  const session =
    driver === "codex-app-server"
      ? new CodexSession(spec, onEvent)
      : new ClaudeSession(spec, onEvent);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.initialize(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native initialization timeout")),
          30000,
        );
      }),
    ]);
    clearTimeout(timer);
    const input = {
      runId: uuid(),
      inputId: uuid(),
      episodeId: uuid(),
      primaryMessageId: uuid(),
      deliveryIds: [],
      text: "Return exactly this nonce and nothing else: " + nonce,
      images: [],
      contextDigest: sha(nonce),
      source: "human_dispatch" as const,
    };
    const receipt = await session.submit(input);
    const end = await Promise.race([
      terminal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native turn timeout")),
          120000,
        );
      }),
    ]);
    clearTimeout(timer);
    const text =
      events
        .filter((e) => e.kind === "message.completed")
        .map((e) => (e as any).text)
        .join("\n") + ((end as any).finalText ?? "");
    results.push({
      driver,
      version: spec.executable.version,
      realPath: path,
      binarySha256: spec.executable.sha256,
      model: session.nativeModel,
      nativeSessionId: session.nativeSessionId,
      receipt: receipt.status,
      nativeOutcome: (end as any).outcome,
      nonceVerified: text.includes(nonce),
      eventCount: events.length,
      status:
        (end as any).outcome === "completed" && text.includes(nonce)
          ? "PASS"
          : "FAIL",
      diagnostics: events
        .filter((e) => e.kind === "diagnostic" || e.kind === "turn.terminal")
        .map((e) => ({
          kind: e.kind,
          ...("error" in e ? { error: e.error } : {}),
        })),
    });
  } catch (e) {
    clearTimeout(timer);
    results.push({
      driver,
      version: spec.executable.version,
      binarySha256: spec.executable.sha256,
      status: "FAIL",
      error: String(e),
      eventCount: events.length,
    });
  } finally {
    if (session instanceof CodexSession && session.nativeSessionId) {
      await session
        .rpc("thread/archive", { threadId: session.nativeSessionId })
        .catch((error) => {
          console.error("Test thread cleanup failed", String(error));
          process.exitCode = 1;
        });
    }
    await session.close().catch(() => {});
  }
  console.log(JSON.stringify(results.at(-1)));
}
mkdirSync("docs/reports", { recursive: true });
writeFileSync(
  "docs/reports/native-probe.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      scope:
        "One default-model nonce request per native Harness. Not full Q0–Q4 qualification.",
      projectRoot: root,
      results,
    },
    null,
    2,
  ) + "\n",
);
process.exitCode = results.every((r) => r.status === "PASS") ? 0 : 1;
