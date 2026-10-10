import { mkdtempSync } from "../scripts/test-resources.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { browseDirectories } from "../apps/control/src/directories.js";
import { createServer } from "../apps/control/src/server.js";
import { uuid, sha } from "../packages/persistence/src/index.js";
test("Directory browser ignores Git by default, probes only on opt-in, and requires owner authentication", async () => {
  const root = mkdtempSync(join(tmpdir(), "harbor-directory-test-"));
  const repo = join(root, "custom project");
  mkdirSync(repo);
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "private.txt"), "not listed");
  let r = await browseDirectories(root);
  assert.deepEqual(
    r.entries.map((x) => x.name),
    ["custom project"],
  );
  assert.equal("git" in r, false);
  assert.equal((await browseDirectories(root, true)).git, null);
  execFileSync("git", ["init", "-b", "main", repo]);
  assert.equal("git" in (await browseDirectories(repo)), false);
  assert.equal((await browseDirectories(repo, true)).git?.hasCommit, false);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  ]);
  assert.equal("git" in (await browseDirectories(repo)), false);
  assert.equal((await browseDirectories(repo, true)).git?.hasCommit, true);
  await assert.rejects(() => browseDirectories("relative/path"));
  await assert.rejects(() => browseDirectories(join(root, "absent")));
  const { app, service, store } = await createServer(join(root, "state"), {
    schedule: false,
    serveWeb: false,
  });
  try {
    const id = uuid();
    store.run(
      "INSERT INTO hosts(id,name,credential_hash,platform,architecture,state) VALUES (?,?,?,?,?,'offline')",
      id,
      hostname(),
      sha("fixture"),
      "darwin",
      "arm64",
    );
    const url = `/v1/hosts/${id}/directories?path=${encodeURIComponent(root)}`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const auth = service.auth.exchange(service.auth.nonce());
    const headers = { cookie: `harbor_session=${auth.session}` };
    const res = await app.inject({ url, headers });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().path, r.path);
    store.run("UPDATE hosts SET name=? WHERE id=?", "other-computer", id);
    assert.equal((await app.inject({ url, headers })).statusCode, 400);
    const ws = service.createWorkspace("custom");
    const ch = service.createChannel(ws.id, "discussion");
    const members = await app.inject({
      url: `/v1/channels/${ch.id}/members`,
      headers,
    });
    assert.equal(members.statusCode, 200);
    assert.deepEqual(members.json().agentIds, []);
  } finally {
    await app.close();
  }
});
