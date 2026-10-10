import { toolDecision } from "../packages/runtime-claude/src/policy.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { computerUseAllowed } from "../packages/runtime-common/src/permissions.js";
import { fixture } from "./helpers.js";
import { execute } from "../apps/control/src/api.js";
import { defaultCapabilities } from "../apps/web/src/capabilities.js";
import { Host } from "../apps/host/src/host.js";

test("Computer Use requires independent opt-in AND Auto Approve/Full Access for both drivers", async () => {
  const f = fixture();
  try {
    assert.equal(defaultCapabilities.includes("desktop.request"), false);
    for (const driver of ["codex-app-server", "claude-code-sdk"]) {
      for (const permissionProfile of [
        "read-only",
        "ask-for-approval",
        "auto-approve",
        "full-access",
        "review",
        "workspace",
        "desktop",
      ]) {
        for (const optedIn of [false, true]) {
          const capabilities = optedIn ? ["desktop.request"] : [];
          const eligible =
            optedIn &&
            ["auto-approve", "full-access"].includes(permissionProfile);
          assert.equal(
            computerUseAllowed(permissionProfile, capabilities),
            eligible,
          );
          const body = {
            hostId: f.host,
            projectId: f.project,
            name: `${driver}-${permissionProfile}-${optedIn}`,
            role: "test",
            runtime: { ...f.agents[0]!.runtime, driver, permissionProfile },
            capabilities,
          };
          if (optedIn && !eligible)
            assert.throws(() => f.s.createAgent(f.ws.id, body), /Computer Use/);
          else {
            const created = f.s.createAgent(f.ws.id, body);
            assert.deepEqual(created.capabilities, capabilities);
          }
          // A hand-crafted computer relay request cannot bypass server-side mode checks.
          const fakeHost = {
            gateway: { provider: null },
            caller: () => {
              throw new Error("Unexpected dispatch");
            },
          };
          const entry = {
            agent: { capabilities },
            session: { spec: { permissionProfile } },
          };
          if (!eligible)
            await assert.rejects(
              () =>
                (Host.prototype as any).tool.call(
                  fakeHost,
                  entry,
                  "tools/list",
                  {},
                  true,
                ),
              /Enable Computer Use/,
            );
          else
            assert.deepEqual(
              await (Host.prototype as any).tool.call(
                fakeHost,
                entry,
                "tools/list",
                {},
                true,
              ),
              [],
            );
        }
      }
    }
  } finally {
    f.db.close();
  }
});

test("Updating an agent cannot retain Computer Use under a disallowed permission mode", () => {
  const f = fixture();
  try {
    const agent = f.agents[0]!;
    const updated = execute(
      f.s,
      "patchAgent",
      { agentId: agent.id },
      {
        expectedVersion: agent.version,
        runtime: { ...agent.runtime, permissionProfile: "full-access" },
        capabilities: ["desktop.request"],
      },
    );
    assert.throws(
      () =>
        execute(
          f.s,
          "patchAgent",
          { agentId: agent.id },
          {
            expectedVersion: updated.version,
            runtime: {
              ...updated.runtime,
              permissionProfile: "ask-for-approval",
            },
          },
        ),
      /Computer Use/,
    );
    const disabled = execute(
      f.s,
      "patchAgent",
      { agentId: agent.id },
      {
        expectedVersion: updated.version,
        runtime: { ...updated.runtime, permissionProfile: "ask-for-approval" },
        capabilities: [],
      },
    );
    assert.deepEqual(disabled.capabilities, []);
  } finally {
    f.db.close();
  }
});

test("Claude Computer Use hooks enforce the separate relay even under Full Access", () => {
  for (const profile of [
    "read-only",
    "ask-for-approval",
    "auto-approve",
    "full-access",
    "desktop",
  ])
    for (const enabled of [false, true]) {
      const spec = {
        permissionProfile: profile,
        mcpServers: enabled ? [{ name: "harbor_computer" }] : [],
      } as any;
      assert.equal(
        toolDecision(spec, "mcp__harbor_computer__js", {}),
        enabled && ["auto-approve", "full-access"].includes(profile)
          ? "allow"
          : "deny",
      );
      assert.equal(
        toolDecision(spec, "mcp__harbor_computer__turn_ended", {}),
        "deny",
      );
    }
});
