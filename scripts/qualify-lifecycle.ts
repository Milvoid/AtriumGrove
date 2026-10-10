import { cleanupRetainedTestResources } from "./test-resources.js";
import { archiveTestThreads } from "./archive-test-threads.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store, uuid, sha } from "../packages/persistence/src/index.js";
import { CodexSession } from "../packages/runtime-codex/src/index.js";
import { ClaudeSession } from "../packages/runtime-claude/src/index.js";
import { until } from "../tests/helpers.js";
import type {
  RuntimeEvent,
  SessionSpec,
  RunInput,
} from "../spec/contracts/runtime.js";
const previous = JSON.parse(
  readFileSync("docs/reports/native-continuity-labeled.json", "utf8"),
);
const db = new Store(join(previous.stateDirectory, "control/control.db"));
const reports: any[] = process.argv.includes("--claude-only")
  ? JSON.parse(
      readFileSync("docs/reports/native-lifecycle.json", "utf8"),
    ).reports.filter((r: any) => r.driver !== "claude-code-sdk")
  : [];
for (const driver of ["codex-app-server", "claude-code-sdk"] as const) {
  if (process.argv.includes("--claude-only") && driver !== "claude-code-sdk")
    continue;
  const prior = previous.agents.find((a: any) => a.driver === driver),
    events: RuntimeEvent[] = [];
  const spec: SessionSpec = {
    agentId: prior.agentId,
    sessionId: uuid(),
    launchId: uuid(),
    generation: 2,
    driver,
    executable: {
      id: "local",
      realPath: prior.executable.executable_realpath,
      sha256: prior.executable.executable_digest,
      version: execFileSync(
        prior.executable.executable_realpath,
        ["--version"],
        { encoding: "utf8" },
      ).trim(),
      authProfileRef: "local-default",
    },
    workspacePath: prior.worktree,
    model: "default",
    permissionProfile: "workspace",
    settingsProfile: "project-reviewed",
    standingInstructions:
      "Continue the owner-requested public test fixture in this disposable repository. No tools are needed.",
    mcpServers: [],
    nativeResumeId: prior.nativeSessionId,
    diagnosticDir: join(previous.stateDirectory, "lifecycle", driver),
  };
  const session =
    driver === "codex-app-server"
      ? new CodexSession(spec, async (e) => {
          events.push(e);
        })
      : new ClaudeSession(spec, async (e) => {
          events.push(e);
        });
  const input = (text: string): RunInput => ({
    runId: uuid(),
    inputId: uuid(),
    episodeId: uuid(),
    primaryMessageId: uuid(),
    deliveryIds: [],
    text,
    images: [],
    contextDigest: sha(text),
    source: "human_dispatch",
  });
  const record: any = {
    driver,
    oldNativeSessionId: prior.nativeSessionId,
    newLaunchId: spec.launchId,
    resume: "NOT_RUN",
    interrupt: "NOT_RUN",
  };
  try {
    await session.initialize();
    const request = input(
      "Please repeat the public fixture label supplied in the earlier native conversation. No tools are needed.",
    );
    await session.submit(request);
    await until(
      () =>
        events.some(
          (e) => e.kind === "turn.terminal" && e.runId === request.runId,
        ),
      120000,
    );
    const answer = events
      .filter((e) => e.runId === request.runId)
      .map((e) =>
        e.kind === "message.completed"
          ? e.text
          : e.kind === "turn.terminal"
            ? (e.finalText ?? "")
            : "",
      )
      .join("\n");
    record.newNativeSessionId = session.nativeSessionId;
    record.resume =
      session.nativeSessionId === prior.nativeSessionId &&
      answer.includes(db.meta("sentinel:" + prior.agentId)!)
        ? "PASS"
        : "FAIL";
    const long = input(
      "For an interruption test, output numbered lines from 1 through 10000, one per line, in order. No tools. Start directly with the numbers.",
    );
    await session.submit(long);
    await until(
      () =>
        events.some(
          (e) =>
            e.runId === long.runId &&
            (e.kind === "message.delta" || e.kind === "turn.terminal"),
        ),
      120000,
    );
    const already = events.some(
      (e) => e.runId === long.runId && e.kind === "turn.terminal",
    );
    if (!already) {
      record.interruptReceipt = await session.interrupt();
      await until(
        () =>
          events.some(
            (e) => e.kind === "turn.terminal" && e.runId === long.runId,
          ),
        30000,
      );
      record.terminal = events.find(
        (e) => e.kind === "turn.terminal" && e.runId === long.runId,
      );
      record.interrupt =
        record.terminal?.outcome === "interrupted" ? "PASS" : "FAIL";
    } else record.interrupt = "INCONCLUSIVE_ALREADY_TERMINAL";
  } catch (error) {
    record.error = String(error);
  } finally {
    record.cleanup = await session.close().catch((e) => ({ error: String(e) }));
    reports.push(record);
    console.log(JSON.stringify(record));
  }
}
db.close();
writeFileSync(
  "docs/reports/native-lifecycle.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      scope:
        "Native process close/resume with original transcript, and interrupt after observed output. No desktop actions.",
      reports,
    },
    null,
    2,
  ) + "\n",
);

if (!process.argv.includes("--keep-state")) {
  const codex = previous.agents.filter(
    (a: any) => a.driver === "codex-app-server",
  );
  await archiveTestThreads(
    codex[0].executable.executable_realpath,
    codex.map((a: any) => a.nativeSessionId).filter(Boolean),
  );
  cleanupRetainedTestResources(previous.stateDirectory);
}
