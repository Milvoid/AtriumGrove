import { mkdtempSync } from "./test-resources.js";
// Initialization only: no prompts, tools, or approval decisions are submitted.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodexSession } from "../packages/runtime-codex/src/index.js";
import { ClaudeSession } from "../packages/runtime-claude/src/index.js";
import { executablePath } from "../packages/runtime-common/src/index.js";
import { sha, uuid } from "../packages/persistence/src/index.js";
import type { SessionSpec } from "../spec/contracts/runtime.js";
const config = JSON.parse(
  readFileSync(join(process.env.HOME!, ".harbor/host/config.json"), "utf8"),
);
const root = mkdtempSync(join(tmpdir(), "harbor-permission-launch-"));

const results: any[] = [];
for (const driver of ["codex-app-server", "claude-code-sdk"] as const) {
  const path = executablePath(
    driver === "codex-app-server" ? config.codexPath : config.claudePath,
  );
  for (const permissionProfile of [
    "read-only",
    "ask-for-approval",
    "auto-approve",
    "full-access",
  ] as const) {
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
      permissionProfile,
      settingsProfile: "isolated",
      standingInstructions: "",
      mcpServers: [],
    };
    const Session =
      driver === "codex-app-server" ? CodexSession : ClaudeSession;
    const session = new Session(spec, async () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.initialize(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Initialization timed out")),
            20000,
          );
        }),
      ]);
      results.push({ driver, permissionProfile, status: "passed" });
    } catch (e) {
      results.push({
        driver,
        permissionProfile,
        status: "failed",
        error: String(e),
      });
    } finally {
      if (timer) clearTimeout(timer);
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
    console.log(driver, permissionProfile, results.at(-1).status);
  }
}
writeFileSync(
  "docs/reports/permission-native-launch.json",
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      scope:
        "Native initialization in a plain directory without Git, no model turns or tool approvals",
      root,
      results,
    },
    null,
    2,
  ) + "\n",
);
if (results.some((x) => x.status !== "passed")) process.exitCode = 1;
