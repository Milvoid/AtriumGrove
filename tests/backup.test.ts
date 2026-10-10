import { mkdtempSync } from "../scripts/test-resources.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../packages/persistence/src/index.js";
import {
  backupState,
  restoreState,
} from "../packages/persistence/src/backup.js";
import { Service } from "../apps/control/src/service.js";

test("F19 F20: backup restores consistent artifact hashes and revokes prior login", async () => {
  const root = mkdtempSync(join(tmpdir(), "harbor-backup-")),
    state = join(root, "state"),
    db = new Store(join(state, "control/control.db")),
    s = new Service(db, state);
  const ws = s.createWorkspace("backup"),
    id = s.artifacts.put(
      ws.id,
      s.auth.owner,
      Buffer.from("immutable evidence"),
      "evidence.txt",
    );
  s.auth.exchange(s.auth.nonce());
  db.close();
  const manifest = await backupState(state, join(root, "snapshot"));
  assert.equal(manifest.artifacts.length, 1);
  restoreState(join(root, "snapshot"), join(root, "restore"));
  const restored = new Store(join(root, "restore/control/control.db")),
    service = new Service(restored, join(root, "restore"));
  assert.equal(
    service.artifacts.read(id, ws.id).bytes.toString(),
    "immutable evidence",
  );
  assert.equal(restored.get("SELECT count(*) n FROM auth_sessions")!.n, 0);
  const staged = service.artifacts.stage(Buffer.from("orphan"), "orphan.txt");
  assert.throws(() =>
    restored.tx(() => {
      service.artifacts.record(ws.id, service.auth.owner, staged);
      throw Error("injected rollback");
    }),
  );
  assert.equal(service.artifacts.collectOrphans(-1), 1);
  assert.equal(
    service.artifacts.read(id, ws.id).bytes.toString(),
    "immutable evidence",
  );
  restored.close();
  writeFileSync(
    join(root, "snapshot/artifacts", manifest.artifacts[0]!.storage_key),
    "corrupt",
  );
  assert.throws(
    () => restoreState(join(root, "snapshot"), join(root, "bad-restore")),
    /digest/,
  );
});
