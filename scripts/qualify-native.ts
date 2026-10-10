import { archiveTestThreads } from "./archive-test-threads.js";
import { mkdtempSync } from "./test-resources.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "../apps/control/src/server.js";
import { Host, type HostConfig } from "../apps/host/src/host.js";
import { uuid, sha } from "../packages/persistence/src/index.js";
import { until } from "../tests/helpers.js";
const noTools = process.argv.includes("--no-tools");
const interactive = process.argv.includes("--interactive");
const state = mkdtempSync(join(tmpdir(), "harbor-native-team-"));
const output = execFileSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "apps/control/src/cli.ts",
    "demo",
    "--native",
    "--state",
    state,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
const demo = JSON.parse(output);
const { app, service, store, scheduler } = await createServer(state, {
  serveWeb: true,
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
const config = JSON.parse(
  readFileSync(join(state, "host", "config.json"), "utf8"),
) as HostConfig;
config.controllerUrl = url;
const host = new Host(config);
let failure: string | null = null;
let cleanupStarted = false;
async function closeQualification() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  scheduler.stop();
  const ids = store
    .all(
      "SELECT native_session_id FROM agent_sessions WHERE driver='codex-app-server' AND native_session_id IS NOT NULL",
    )
    .map((row) => row.native_session_id as string);
  await host.close();
  await app.close();
  if (!process.argv.includes("--keep-state"))
    await archiveTestThreads(config.codexPath, ids);
}
if (interactive) {
  console.log(
    JSON.stringify({
      url,
      state,
      loginToken: service.auth.nonce(),
      mode: "native",
      purpose: "Human-supervised tool qualification",
    }),
  );
  writeFileSync(
    "docs/reports/native-supervised.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        status: "WAITING_HUMAN",
        url,
        stateDirectory: state,
        scope: "Native collaboration tool approvals only; no desktop grants",
      },
      null,
      2,
    ) + "\n",
  );
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => {
      scheduler.stop();
      void closeQualification().then(() => process.exit(0));
    });
}
try {
  await host.start();
  await until(() => service.connectedHosts.has(config.hostId));
  for (const agentId of demo.agentIds) {
    const nonce = "HARBOR_" + uuid();
    store.setMeta("sentinel:" + agentId, nonce);
    service.mutate(service.auth.owner, "qualification", uuid(), {}, () =>
      service.post(demo.channelId, {
        blocks: [
          {
            type: "text",
            text: `This is an owner-requested test in a dedicated disposable repository. Remember the public fixture label ${nonce}; it is generated test data, not a credential. ${noTools ? "Reply with the public fixture label as text. No tools are needed for this part of the test." : "Call collab_context once to verify your identity and report this exact sentinel with your assigned worktree."} Do not ask another agent. Do not edit files or use shell. End with a concise root final answer.`,
          },
        ],
        recipientAgentIds: [agentId],
        requestResponse: true,
        kind: "message",
        clientMessageId: uuid(),
      }),
    );
  }
  await until(
    () =>
      store.get(
        "SELECT count(*) n FROM runs WHERE state IN ('completed','failed','interrupted')",
      )!.n === 5 ||
      (!interactive &&
        store.get("SELECT count(*) n FROM approvals WHERE state='pending'")!.n >
          0),
    interactive ? 600000 : 180000,
  );
  if (
    store.get("SELECT count(*) n FROM approvals WHERE state='pending'")!.n > 0
  )
    throw new Error(
      "Native approval requires a human decision; no automatic approval was applied",
    );
  const first = store.all("SELECT * FROM runs");
  if (first.some((r) => r.state !== "completed"))
    throw new Error("At least one native run failed");
  console.log("Five native first turns completed.");
  for (const agentId of demo.agentIds)
    service.mutate(service.auth.owner, "qualification-memory", uuid(), {}, () =>
      service.post(demo.channelId, {
        blocks: [
          {
            type: "text",
            text: "Please repeat the public fixture label I supplied in our previous turn. It was generated test data. Use your own conversation memory; no tools or other agents are needed.",
          },
        ],
        recipientAgentIds: [agentId],
        requestResponse: true,
        kind: "message",
        clientMessageId: uuid(),
      }),
    );
  await until(
    () =>
      store.get(
        "SELECT count(*) n FROM runs WHERE state IN ('completed','failed','interrupted')",
      )!.n === 10,
    180000,
  );
} catch (e) {
  failure = String(e);
  console.error(failure);
} finally {
  scheduler.stop();
  const agents = store.all("SELECT * FROM agents");
  const sessions = store.all("SELECT * FROM agent_sessions");
  const runs = store.all("SELECT * FROM runs");
  const checks = agents.map((a) => {
    const own = runs.filter((r) => r.agent_id === a.id);
    return {
      agentId: a.id,
      name: a.name,
      driver: JSON.parse(a.runtime_json).driver,
      executable: host.db.get(
        "SELECT executable_realpath,executable_digest,pid,pid_started_at FROM launches WHERE agent_id=?",
        a.id,
      ),
      resolvedModel:
        host.db.meta(
          "model:" + sessions.find((s) => s.agent_id === a.id)?.launch_id,
        ) ?? "unknown",
      nativeSessionId: sessions.find((s) => s.agent_id === a.id)
        ?.native_session_id,
      worktree: sessions.find((s) => s.agent_id === a.id)?.workspace_path,
      turns: own.map((r) => ({
        id: r.id,
        state: r.state,
        nonceVerified: r.final_message_id
          ? JSON.parse(
              store.entity("messages", r.final_message_id).blocks_json,
            ).some((b: any) => b.text?.includes(store.meta("sentinel:" + a.id)))
          : false,
      })),
      toolCompletions: store.get(
        "SELECT count(*) n FROM runtime_events WHERE agent_id=? AND kind='tool.completed'",
        a.id,
      )!.n,
    };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    scope: noTools
      ? "Five native sessions and two-turn transcript continuity only. Tool approval, resume, interrupt and desktop are separate unpassed gates."
      : "Five native sessions, read-only collaboration tool call and transcript continuity. Resume/interrupt/desktop qualification tracked separately.",
    stateDirectory: state,
    projectRoot: demo.projectRoot,
    lockfileSha256: sha(readFileSync("pnpm-lock.yaml")),
    failure,
    agents: checks,
    pendingApprovals: store.all(
      "SELECT id,title,source FROM approvals WHERE state='pending'",
    ),
    operations: store.all(
      "SELECT state,error_json FROM operations WHERE state IN ('failed','unknown')",
    ),
    status:
      !failure &&
      checks.every(
        (a) =>
          a.turns.length === 2 &&
          a.turns.every((r) => r.state === "completed" && r.nonceVerified) &&
          (noTools || a.toolCompletions > 0),
      )
        ? "PASS"
        : "FAIL",
  };
  mkdirSync("docs/reports", { recursive: true });
  writeFileSync(
    noTools
      ? "docs/reports/native-continuity-labeled.json"
      : interactive
        ? "docs/reports/native-supervised.json"
        : "docs/reports/native-team.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: report.status,
      stateDirectory: state,
      agents: checks.map((a) => ({
        name: a.name,
        turns: a.turns,
        toolCompletions: a.toolCompletions,
      })),
    }),
  );
  if (!interactive) {
    await closeQualification();
    process.exitCode = report.status === "PASS" ? 0 : 1;
  } else
    console.log(
      "Qualification report saved; UI remains available until this process is stopped.",
    );
}
