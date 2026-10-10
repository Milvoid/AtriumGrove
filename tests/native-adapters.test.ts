import { mkdtempSync } from "../scripts/test-resources.js";
import { codexPermissions } from "../packages/runtime-common/src/permissions.js";
import {
  toolDecision,
  claudePermissions,
} from "../packages/runtime-claude/src/policy.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { CodexSession } from "../packages/runtime-codex/src/index.js";
import { sha, uuid } from "../packages/persistence/src/index.js";
import { until } from "./helpers.js";
import type {
  SessionSpec,
  RunInput,
  RuntimeEvent,
} from "../spec/contracts/runtime.js";

test("Fake subprocess: interleaved messages retain IDs, tool completion is not terminal, interrupt observes native terminal", async () => {
  const path = resolve("tests/fixtures/fake-codex.mjs");
  chmodSync(path, 0o700);
  const dir = mkdtempSync(join(tmpdir(), "harbor-protocol-")),
    events: RuntimeEvent[] = [];
  const spec: SessionSpec = {
    agentId: uuid(),
    sessionId: uuid(),
    launchId: uuid(),
    generation: 1,
    driver: "codex-app-server",
    executable: {
      id: "fake",
      realPath: path,
      sha256: sha(readFileSync(path)),
      version: "fake",
      authProfileRef: "none",
    },
    workspacePath: dir,
    model: "default",
    permissionProfile: "review",
    settingsProfile: "isolated",
    standingInstructions: "test",
    mcpServers: [],
    diagnosticDir: join(dir, "diagnostics"),
  };
  const input = (): RunInput => ({
    runId: uuid(),
    inputId: uuid(),
    episodeId: uuid(),
    primaryMessageId: uuid(),
    deliveryIds: [],
    text: "hold until released",
    images: [],
    contextDigest: "test",
    source: "human_dispatch",
  });
  const session = new CodexSession(spec, async (e) => {
    events.push(e);
  });
  try {
    await session.initialize();
    assert.equal((await session.submit(input())).status, "accepted");
    await until(() => events.some((e) => e.kind === "native.unmapped"));
    assert.equal(events.filter((e) => e.kind === "turn.terminal").length, 0);
    const grouped = new Map<string, string>();
    for (const e of events)
      if (e.kind === "message.delta")
        grouped.set(e.messageId, (grouped.get(e.messageId) ?? "") + e.text);
    assert.equal(grouped.get("message-a"), "A1A2");
    assert.equal(grouped.get("message-b"), "B1");
    const tool = events.find((e) => e.kind === "tool.started");
    assert.ok(
      tool?.kind === "tool.started" && tool.input.command === "printf streamed",
    );
    assert.ok(
      events.some((e) => e.kind === "tool.progress" && e.text === "streamed"),
    );
    assert.equal(readdirSync(spec.diagnosticDir!).length, 1);
    await session.rpc("test/release", {});
    await until(() => events.some((e) => e.kind === "turn.terminal"));
    assert.equal((await session.reconcile()).activeTurn, "not_running");
    await session.submit(input());
    await until(
      () => events.filter((e) => e.kind === "turn.started").length === 2,
    );
    await session.interrupt();
    await until(() =>
      events.some(
        (e) => e.kind === "turn.terminal" && e.outcome === "interrupted",
      ),
    );
  } finally {
    assert.equal((await session.close()).resourcesQuiescent, true);
  }
});

test("A34: PreToolUse denies reviewed writes and symlink escape despite cached native approval", () => {
  const root = mkdtempSync(join(tmpdir(), "harbor-policy-")),
    outside = mkdtempSync(join(tmpdir(), "harbor-outside-"));
  symlinkSync(outside, join(root, "linked"));
  const spec = {
    workspacePath: root,
    permissionProfile: "review",
    mcpServers: [{ name: "harbor" }],
  } as SessionSpec;
  assert.equal(
    toolDecision(spec, "Write", { file_path: join(root, "file") }),
    "deny",
  );
  assert.equal(
    toolDecision(spec, "Read", { file_path: join(root, "linked", "private") }),
    "deny",
  );
  assert.equal(
    toolDecision(spec, "Read", { file_path: join(root, "new-file") }),
    "allow",
  );
  assert.equal(toolDecision(spec, "mcp__harbor__collab_context", {}), "allow");
  assert.equal(
    toolDecision(spec, "mcp__harborEvil__collab_context", {}),
    "deny",
  );
  assert.equal(toolDecision(spec, "Agent", {}), "deny");
});

for (const [profile, sandbox, approvalPolicy] of [
  ["read-only", "read-only", "never"],
  ["ask-for-approval", "read-only", "on-request"],
  ["auto-approve", "workspace-write", "on-request"],
  ["full-access", "danger-full-access", "never"],
] as const) {
  test(`Codex ${profile}: serialized start and resume parameters match pinned native schema`, async () => {
    const path = resolve("tests/fixtures/fake-codex.mjs");
    const root = mkdtempSync(join(tmpdir(), "harbor-permissions-"));
    for (const resume of [false, true]) {
      const spec = {
        agentId: uuid(),
        sessionId: uuid(),
        launchId: uuid(),
        generation: 1,
        driver: "codex-app-server",
        executable: {
          id: "fake",
          realPath: path,
          sha256: sha(readFileSync(path)),
          version: "fake",
          authProfileRef: "none",
        },
        workspacePath: root,
        model: "default",
        permissionProfile: profile,
        settingsProfile: "isolated",
        standingInstructions: "test",
        mcpServers: [],
        ...(resume ? { nativeResumeId: "fake-thread" } : {}),
      } as SessionSpec;
      const session = new CodexSession(spec, async () => {});
      try {
        await session.initialize();
        const actual = (await session.rpc("test/permissions", {})) as any;
        assert.equal(actual.config["features.computer_use"], false);
        assert.equal(actual.config["features.plugins"], false);
        assert.equal(
          actual.config.mcp_servers.unmanaged_computer.enabled,
          false,
        );
        assert.equal(actual.sandbox, sandbox);
        assert.equal(actual.approvalPolicy, approvalPolicy);
        assert.equal(
          actual.config["sandbox_workspace_write.network_access"],
          false,
        );
      } finally {
        await session.close();
      }
    }
  });
}

test("Claude permission modes gate writes, preserve native sandbox checks, and allow explicit full access", () => {
  const root = mkdtempSync(join(tmpdir(), "harbor-mode-"));
  const outside = mkdtempSync(join(tmpdir(), "harbor-outside-"));
  symlinkSync(outside, join(root, "linked"));
  const spec = (permissionProfile: SessionSpec["permissionProfile"]) =>
    ({
      workspacePath: root,
      permissionProfile,
      mcpServers: [],
    }) as unknown as SessionSpec;
  const ro = spec("read-only"),
    ask = spec("ask-for-approval"),
    auto = spec("auto-approve"),
    full = spec("full-access");
  assert.equal(claudePermissions(ro).permissionMode, "plan");
  assert.equal(claudePermissions(ask).permissionMode, "default");
  assert.equal(claudePermissions(auto).permissionMode, "acceptEdits");
  assert.equal(claudePermissions(auto).sandbox?.failIfUnavailable, true);
  assert.equal(
    claudePermissions(auto).sandbox?.allowUnsandboxedCommands,
    false,
  );
  assert.equal(claudePermissions(auto).sandbox?.autoAllowBashIfSandboxed, true);
  assert.equal(claudePermissions(full).permissionMode, "bypassPermissions");
  assert.equal(claudePermissions(full).allowDangerouslySkipPermissions, true);
  assert.equal(claudePermissions(full).sandbox?.enabled, false);
  for (const name of [
    "Write",
    "Edit",
    "NotebookEdit",
    "Bash",
    "mcp__external__mutate",
  ])
    assert.equal(toolDecision(ro, name, {}), "deny");
  assert.equal(
    toolDecision(ro, "Read", { file_path: join(root, "a") }),
    "allow",
  );
  for (const name of ["Write", "Edit", "Bash"])
    assert.equal(toolDecision(ask, name, {}), "ask");
  for (const name of ["Write", "Edit", "Bash"])
    assert.equal(toolDecision(auto, name, {}), undefined);
  for (const mode of [ro, ask, auto])
    assert.equal(
      toolDecision(mode, "Edit", { file_path: join(root, "linked", "a") }),
      "deny",
    );
  assert.equal(
    toolDecision(full, "Edit", { file_path: join(outside, "a") }),
    undefined,
  );
  assert.equal(toolDecision(full, "Bash", { command: "echo test" }), undefined);
  assert.equal(toolDecision(full, "AskUserQuestion", {}), "ask");
  assert.deepEqual(codexPermissions("workspace"), {
    sandbox: "workspace-write",
    approvalPolicy: "untrusted",
  });
});
