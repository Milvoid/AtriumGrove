import { mkdtempSync } from "../scripts/test-resources.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "../apps/control/src/server.js";
import { Host, type HostConfig } from "../apps/host/src/host.js";
import { uuid } from "../packages/persistence/src/index.js";
import { until } from "./helpers.js";

for (const workspaceMode of [
  "git-worktree",
  "directory",
  "directory-in-git",
] as const)
  test(`Five fake sessions in ${workspaceMode} through authenticated Host, MCP, durable events and final answers`, async () => {
    const state = mkdtempSync(join(tmpdir(), "harbor-e2e-"));
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "apps/control/src/cli.ts", "demo", "--state", state],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const demo = JSON.parse(output);
    const { app, service, store } = await createServer(state, {
      serveWeb: false,
    });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const config = JSON.parse(
      readFileSync(join(state, "host", "config.json"), "utf8"),
    ) as HostConfig;
    config.controllerUrl = url;
    config.codexPath = "/nonexistent/codex";
    config.claudePath = "/nonexistent/claude";
    let sharedPath: string | undefined;
    if (workspaceMode !== "git-worktree") {
      const directory =
        workspaceMode === "directory"
          ? join(state, "ordinary-folder")
          : join(state, "demo-project", "nested");
      mkdirSync(directory);
      sharedPath = realpathSync(directory);
      store.run(
        "UPDATE projects SET root_path=?,workspace_mode='directory'",
        sharedPath,
      );
    }
    const host = new Host(config);
    try {
      await host.start();
      await until(() => service.connectedHosts.has(config.hostId));
      if (workspaceMode === "directory") {
        const gitRoot = join(state, "explicit-git");
        mkdirSync(gitRoot);
        writeFileSync(join(gitRoot, "README.md"), "fixture");
        const endpoint = `/v1/hosts/${config.hostId}/git`;
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: endpoint,
              payload: { rootPath: gitRoot },
            })
          ).statusCode,
          401,
        );
        const auth = service.auth.exchange(service.auth.nonce());
        const headers = {
          cookie: `harbor_session=${auth.session}`,
          "X-CSRF-Token": auth.csrf,
          "Idempotency-Key": uuid(),
        };
        const response = await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: { rootPath: gitRoot },
        });
        assert.equal(response.statusCode, 202, response.body);
        const retry = await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: { rootPath: gitRoot },
        });
        assert.equal(retry.json().id, response.json().id);
        await until(
          () =>
            store.entity("operations", response.json().id).state ===
            "completed",
        );
        assert.equal(
          execFileSync("git", ["-C", gitRoot, "show", "HEAD:README.md"], {
            encoding: "utf8",
          }),
          "fixture",
        );
      }
      service.mutate(service.auth.owner, "post", uuid(), {}, () =>
        service.post(demo.channelId, {
          blocks: [
            { type: "text", text: "Report receipt of this deterministic test" },
          ],
          recipientAgentIds: demo.agentIds,
          requestResponse: true,
          kind: "message",
          clientMessageId: uuid(),
        }),
      );
      await until(
        () =>
          store.get("SELECT count(*) n FROM runs WHERE state='completed'")!
            .n === 5,
        15000,
      );
      if (sharedPath) {
        assert.equal(
          store.get(
            "SELECT count(*) n FROM agent_sessions WHERE workspace_path=?",
            sharedPath,
          )!.n,
          5,
        );
        assert.equal(existsSync(join(sharedPath, ".git")), false);
        assert.equal(
          existsSync(join(state, "worktrees", demo.workspaceId)),
          false,
        );
      }
      assert.equal(
        store.get(
          "SELECT count(DISTINCT native_session_id) n FROM agent_sessions",
        )!.n,
        5,
      );
      assert.equal(
        store.get("SELECT count(*) n FROM messages WHERE kind='answer'")!.n,
        5,
      );
      assert.equal(
        store.get(
          "SELECT count(*) n FROM runtime_events WHERE kind='tool.completed'",
        )!.n,
        5,
      );
      assert.equal(
        store.get(
          "SELECT count(*) n FROM runs WHERE state NOT IN ('completed','failed','interrupted')",
        )!.n,
        0,
      );
      await until(
        () => host.db.get("SELECT count(*) n FROM event_spool")!.n === 0,
      );
    } finally {
      await host.close();
      await app.close();
    }
  });
