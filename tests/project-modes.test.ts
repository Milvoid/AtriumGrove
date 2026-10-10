import { mkdtempSync } from "../scripts/test-resources.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  prepareWorkspace,
  initializeGit,
  gitAssociation,
  git,
} from "../packages/worktrees/src/index.js";
import { fixture } from "./helpers.js";
import { execute } from "../apps/control/src/api.js";
import { Scheduler } from "../apps/control/src/runtime.js";
import { Store, sha } from "../packages/persistence/src/index.js";

test("Plain folder browse and launch never execute Git, including .git-bearing folders", async () => {
  const root = mkdtempSync(join(tmpdir(), "harbor-no-git-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const marker = join(root, "git-called");
  writeFileSync(join(bin, "git"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(join(bin, "git"), 0o755);
  mkdirSync(join(root, ".git")); // Deliberately broken metadata must also be ignored.
  const code = `import { browseDirectories } from './apps/control/src/directories.ts'; import { prepareWorkspace } from './packages/worktrees/src/index.ts'; const root = process.argv[1]; const listing = await browseDirectories(root); if ('git' in listing) throw Error('Unexpected Git inspection'); const path = await prepareWorkspace(root, 'ws', 'agent', 1, {rootPath:root,baseRef:'HEAD',workspaceMode:'directory'}); if(path !== listing.path) throw Error('cwd changed');`;
  execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code, root],
    { env: { ...process.env, PATH: bin + ":/usr/bin:/bin" } },
  );
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(root, "worktrees")), false);
});

test("Explicit initialization preserves ignored files, commits visible files, and is retry-safe; Git subfolder gets an isolated cwd", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harbor-opt-in-")));
  const state = mkdtempSync(join(tmpdir(), "harbor-opt-state-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.txt"), "initial");
  writeFileSync(join(root, ".gitignore"), "private.txt\n");
  writeFileSync(join(root, "private.txt"), "do not commit");
  assert.equal(await gitAssociation(root), null);
  const init = await initializeGit(root);
  assert.equal(init.hasCommit, true);
  const first = await git(root, ["rev-parse", "HEAD"]);
  await initializeGit(root);
  assert.equal(await git(root, ["rev-parse", "HEAD"]), first);
  assert.equal(await git(root, ["ls-files", "private.txt"]), "");
  assert.equal(
    readFileSync(join(root, "private.txt"), "utf8"),
    "do not commit",
  );
  const sub = join(root, "src");
  assert.equal((await gitAssociation(sub))?.repositoryRoot, root);
  const shared = await prepareWorkspace(state, "ws", "shared", 1, {
    rootPath: sub,
    baseRef: "HEAD",
    workspaceMode: "directory",
  });
  assert.equal(shared, sub);
  const isolated = await prepareWorkspace(state, "ws", "isolated", 1, {
    rootPath: sub,
    baseRef: "HEAD",
    workspaceMode: "git-worktree",
  });
  assert.notEqual(isolated, sub);
  assert.equal(readFileSync(join(isolated, "app.txt"), "utf8"), "initial");
  writeFileSync(join(isolated, "app.txt"), "changed");
  assert.equal(readFileSync(join(sub, "app.txt"), "utf8"), "initial");
  assert.equal(
    await prepareWorkspace(state, "ws", "isolated", 2, {
      rootPath: sub,
      baseRef: "HEAD",
      workspaceMode: "git-worktree",
    }),
    isolated,
  );
});

test("Project defaults to shared directory and changing mode is blocked while active; old native transcript is not resumed in a different mode", () => {
  const f = fixture();
  try {
    const p = execute(
      f.s,
      "createProject",
      { workspaceId: f.ws.id },
      { hostId: f.host, rootPath: join(f.dir, "new"), name: "normal" },
    );
    assert.equal(p.workspaceMode, "directory");
    assert.equal(f.s.get("Project", f.project).workspaceMode, "git-worktree");
    f.s.post(f.channel.id, f.message([f.agents[0]!.id]));
    const scheduler = new Scheduler(f.s);
    f.s.connectedHosts.add(f.host);
    f.db.run(
      "UPDATE agents SET desired_state='running' WHERE id=?",
      f.agents[0]!.id,
    );
    scheduler.tick();
    assert.throws(
      () =>
        execute(
          f.s,
          "createProject",
          { workspaceId: f.ws.id },
          {
            hostId: f.host,
            rootPath: f.dir,
            name: "test",
            expectedVersion: 1,
            workspaceMode: "directory",
          },
        ),
      /取消/,
    );
    const old = f.db.get(
      "SELECT * FROM agent_sessions WHERE agent_id=?",
      f.agents[0]!.id,
    )!;
    f.db.run(
      "UPDATE agent_sessions SET state='closed',native_session_id='old-transcript' WHERE id=?",
      old.id,
    );
    f.db.run(
      "UPDATE agents SET desired_state='stopped' WHERE id=?",
      f.agents[0]!.id,
    );
    const updated = execute(
      f.s,
      "createProject",
      { workspaceId: f.ws.id },
      {
        hostId: f.host,
        rootPath: f.dir,
        name: "test",
        expectedVersion: 1,
        workspaceMode: "directory",
      },
    );
    assert.equal(updated.id, f.project);
    assert.equal(updated.workspaceMode, "directory");
    f.db.run(
      "UPDATE agents SET desired_state='running' WHERE id=?",
      f.agents[0]!.id,
    );
    scheduler.tick();
    const next = f.db.get(
      "SELECT * FROM agent_sessions WHERE agent_id=? ORDER BY generation DESC LIMIT 1",
      f.agents[0]!.id,
    )!;
    assert.equal(next.native_session_id, null);
    assert.equal(next.workspace_path, f.dir);
  } finally {
    f.db.close();
  }
});

test("Existing database migration preserves worktrees and runs once", () => {
  const root = mkdtempSync(join(tmpdir(), "harbor-mode-migration-")),
    path = join(root, "old.db");
  const current = new Store(path);
  current.db.exec(
    "ALTER TABLE projects DROP COLUMN workspace_mode; DELETE FROM schema_migrations WHERE version=3;",
  );
  current.close();
  const migrated = new Store(path);
  assert.equal(
    migrated.get(
      "SELECT dflt_value FROM pragma_table_info('projects') WHERE name='workspace_mode'",
    )!.dflt_value,
    "'git-worktree'",
  );
  migrated.close();
  const reopened = new Store(path);
  assert.equal(
    reopened.get("SELECT count(*) n FROM schema_migrations WHERE version=3")!.n,
    1,
  );
  reopened.close();
});

test("Legacy Git sessions keep their transcript when the workspace mode has not changed", () => {
  const f = fixture();
  try {
    const a = f.db.entity("agents", f.agents[0]!.id);
    f.s.connectedHosts.add(f.host);
    f.db.run("UPDATE agents SET desired_state='running' WHERE id=?", a.id);
    f.s.post(f.channel.id, f.message([f.agents[0]!.id]));
    const scheduler = new Scheduler(f.s);
    scheduler.tick();
    f.db.run(
      "UPDATE agent_sessions SET state='closed',native_session_id='legacy-transcript',config_digest=? WHERE agent_id=?",
      sha(a.runtime_json + a.capabilities_json),
      a.id,
    );
    scheduler.tick();
    const session = f.db.get(
      "SELECT * FROM agent_sessions WHERE agent_id=? ORDER BY generation DESC LIMIT 1",
      a.id,
    )!;
    assert.equal(session.native_session_id, "legacy-transcript");
  } finally {
    f.db.close();
  }
});
