import { mkdtempSync } from "./test-resources.js";
import { archiveTestThreads } from "./archive-test-threads.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "../apps/control/src/server.js";
import { Host, type HostConfig } from "../apps/host/src/host.js";
import { execute } from "../apps/control/src/api.js";
import { uuid } from "../packages/persistence/src/index.js";
import { until } from "../tests/helpers.js";

// The human must explicitly authorize this exact disposable Calculator acceptance run.
if (!process.argv.includes("--calculator-authorized"))
  throw new Error(
    "Request human authorization for the Calculator acceptance run first",
  );
const production = JSON.parse(
  readFileSync(join(homedir(), ".harbor/host/config.json"), "utf8"),
);
if (!production.lcu?.qualification)
  throw new Error("Complete setup-computer.ts --verify first");
// Use the same already-configured CLI login environment as the running service; never print it.
const plist = join(
  homedir(),
  "Library/LaunchAgents/org.atriumgrove.harbor.host.plist",
);
const configured = JSON.parse(
  execFileSync(
    "plutil",
    ["-extract", "EnvironmentVariables", "json", "-o", "-", plist],
    { encoding: "utf8" },
  ),
);
for (const [key, value] of Object.entries(configured))
  if (key.startsWith("ANTHROPIC_") && typeof value === "string")
    process.env[key] = value;
const state = mkdtempSync(join(tmpdir(), "cu-"));
const demo = JSON.parse(
  execFileSync(
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
  ),
);
const { app, service, store, scheduler } = await createServer(state, {
  serveWeb: false,
});
const url = await app.listen({ host: "127.0.0.1", port: 0 });
const config: HostConfig = {
  ...JSON.parse(readFileSync(join(state, "host/config.json"), "utf8")),
  controllerUrl: url,
  lcu: production.lcu,
};
store.run("UPDATE projects SET workspace_mode='directory'");
const chosen = [
  store.get(
    "SELECT * FROM agents WHERE json_extract(runtime_json,'$.driver')='codex-app-server' LIMIT 1",
  )!,
  store.get(
    "SELECT * FROM agents WHERE json_extract(runtime_json,'$.driver')='claude-code-sdk' LIMIT 1",
  )!,
];
for (const [index, a] of chosen.entries()) {
  const runtime = JSON.parse(a.runtime_json);
  runtime.permissionProfile = index ? "auto-approve" : "full-access";
  store.run(
    "UPDATE agents SET runtime_json=?,capabilities_json=? WHERE id=?",
    JSON.stringify(runtime),
    JSON.stringify(["desktop.request"]),
    a.id,
  );
}
const host = new Host(config),
  checks: any[] = [];
let approvalCount = 0,
  error: string | undefined;
let monitorBusy = false;
const monitor = setInterval(() => {
  if (monitorBusy) return;
  monitorBusy = true;
  try {
    for (const pending of store.all(
      "SELECT * FROM approvals WHERE state='pending'",
    )) {
      const approval = service.get("Approval", pending.id);
      const allowed =
        chosen.some((a) => a.id === pending.agent_id) &&
        approval.source === "computer-use" &&
        approval.display?._meta?.tool_params?.app === "com.apple.calculator";
      if (!allowed) {
        error =
          "An approval outside the human-authorized Calculator fixture requires review";
        continue;
      }
      // Forward the user's explicit one-time acceptance authorization, never a persistent app grant.
      execute(
        service,
        "resolveApproval",
        { approvalId: approval.id },
        {
          argumentHash: approval.argumentHash,
          expectedVersion: approval.version,
          action: "approve",
          content: {},
          scope: "once",
        },
      );
      approvalCount++;
    }
  } catch (e) {
    error = String(e);
  } finally {
    monitorBusy = false;
  }
}, 200);
try {
  await host.start();
  await until(() => service.connectedHosts.has(config.hostId));
  for (const agent of process.argv.includes("--stop-only") ? [] : chosen) {
    console.log(
      JSON.stringify({
        phase: "starting",
        driver: JSON.parse(agent.runtime_json).driver,
      }),
    );
    const posted = service.mutate(
      service.auth.owner,
      "computer-acceptance",
      uuid(),
      {},
      () =>
        service.post(demo.channelId, {
          blocks: [
            {
              type: "text",
              text: "This is a human-authorized disposable Computer Use acceptance test. Only use the harbor_computer js/js_reset tools and the original cua API. The human authorized Calculator only, computing 2+2, taking a screenshot, and clearing the result for this acceptance run. Start with exactly: var calculator = await cua.getApp('com.apple.calculator'); then read the returned API documentation. Use Calculator to compute 2+2 and return its screenshot through the tool. Read the screenshot and tell me the number you observed. Clear Calculator afterward. Do not use shell, file tools, other apps, other MCP servers, or other agents. Do not reset the REPL before the screenshot. Finish with the exact phrase COMPUTER_ACCEPTANCE_OK and the observed number if successful; report actual errors if unsuccessful.",
            },
          ],
          recipientAgentIds: [agent.id],
          requestResponse: true,
          kind: "message",
          clientMessageId: uuid(),
        }),
    );
    await until(
      () =>
        !!error ||
        !!store.get(
          "SELECT 1 FROM runs WHERE primary_message_id=? AND state IN ('completed','failed','interrupted')",
          posted.id,
        ),
      300000,
    );
    if (error) throw new Error(error);
    const run = store.get(
      "SELECT * FROM runs WHERE primary_message_id=?",
      posted.id,
    )!;
    const events = store
      .all(
        "SELECT kind,payload_json FROM runtime_events WHERE run_id=? ORDER BY producer_seq",
        run.id,
      )
      .map((row) => ({ kind: row.kind, ...JSON.parse(row.payload_json) }));
    const images = events.flatMap((e) =>
      e.kind === "tool.completed" ? (e.result?.observations ?? []) : [],
    );
    const final = run.final_message_id
      ? JSON.parse(store.entity("messages", run.final_message_id).blocks_json)
          .map((b: any) => b.text ?? "")
          .join("\n")
      : "";
    const check = {
      toolNames: events
        .filter((e) => e.kind === "tool.started")
        .map((e) => e.name),
      driver: JSON.parse(agent.runtime_json).driver,
      state: run.state,
      computerActions: events.filter(
        (e) => e.kind === "tool.started" && e.name === "computer",
      ).length,
      screenshots: images.filter((o) => o.artifactId).length,
      screenshotErrors: images.filter((o) => o.error).map((o) => o.error),
      nativeSawScreenshot:
        /COMPUTER_ACCEPTANCE_OK/.test(final) && /4/.test(final),
      desktopState: host.gateway.state().state,
      final,
    };
    checks.push(check);
    console.log(JSON.stringify(check));
    if (
      check.state !== "completed" ||
      !check.nativeSawScreenshot ||
      !check.screenshots ||
      check.desktopState !== "free"
    )
      throw new Error("Computer acceptance failed");
  }
  if (process.argv.includes("--stop-only")) {
    const agent = chosen[0]!;
    console.log(
      JSON.stringify({ phase: "stop-test", driver: "codex-app-server" }),
    );
    const message = service.post(demo.channelId, {
      blocks: [
        {
          type: "text",
          text: "Human-authorized Calculator Computer Use cancellation acceptance test. Only use harbor_computer tools. First call exactly var calculator = await cua.getApp('com.apple.calculator'); and read the returned guide. Then use js once with title 'Atrium Grove stop probe' and code await new Promise(resolve => setTimeout(resolve, 30000));. The user will interrupt that tool to verify cancellation. Do not call other tools, apps or agents. No calculations or file changes are needed.",
        },
      ],
      recipientAgentIds: [agent.id],
      requestResponse: true,
      kind: "message",
      clientMessageId: uuid(),
    });
    await until(
      () =>
        !!error ||
        (!!store.get(
          "SELECT 1 FROM runtime_events WHERE kind='tool.started' AND json_extract(payload_json,'$.name')='computer' AND json_extract(payload_json,'$.input.title')='Atrium Grove stop probe'",
        ) &&
          host.gateway.state().pending_calls > 0),
      180000,
    );
    if (error) throw new Error(error);
    const run = store.get(
      "SELECT * FROM runs WHERE primary_message_id=?",
      message.id,
    )!;
    const operation = execute(
      service,
      "desktopControl",
      { hostId: config.hostId },
      { action: "stop", reason: "Human-authorized acceptance test" },
    );
    await until(
      () =>
        ["completed", "failed"].includes(
          store.entity("operations", operation.id).state,
        ),
      60000,
    );
    await until(
      () =>
        store.entity("runs", run.id).state === "interrupted" &&
        host.gateway.state().state === "free",
      60000,
    );
    const check = {
      test: "stop-active-computer-call",
      runState: store.entity("runs", run.id).state,
      desktopState: host.gateway.state().state,
      pendingCalls: host.gateway.state().pending_calls,
      cleanupConfirmed: !!host.gateway.state().last_cleanup_receipt,
    };
    checks.push(check);
    console.log(JSON.stringify(check));
  }
} catch (e) {
  error = String(e);
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  scheduler.stop();
  const ids = store
    .all(
      "SELECT native_session_id FROM agent_sessions WHERE driver='codex-app-server' AND native_session_id IS NOT NULL",
    )
    .map((r) => r.native_session_id as string);
  writeFileSync(
    process.argv.includes("--stop-only")
      ? "docs/reports/computer-stop.json"
      : "docs/reports/computer-harnesses.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        checks,
        approvalCount,
        error: error ?? null,
      },
      null,
      2,
    ) + "\n",
  );
  await host.close();
  await app.close();
  await archiveTestThreads(config.codexPath, ids);
  if (error) console.error(error);
}
