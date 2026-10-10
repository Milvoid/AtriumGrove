import { backup } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { Store, sha, now, uuid } from "./index.js";
import { invariant } from "../../domain/src/index.js";

export async function backupState(state: string, destination: string) {
  invariant(
    !existsSync(destination),
    "BACKUP_EXISTS",
    "Use a new backup destination",
  );
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const db = new Store(join(state, "control/control.db"));
  try {
    await backup(db.db, join(destination, "control.db"));
    const snapshot = new Store(join(destination, "control.db"));
    const artifacts = snapshot.all(
      "SELECT storage_key,sha256 FROM artifacts WHERE deleted_at IS NULL",
    );
    snapshot.close();
    for (const artifact of artifacts) {
      const target = join(destination, "artifacts", artifact.storage_key);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(join(state, "artifacts", artifact.storage_key), target);
      invariant(
        sha(readFileSync(target)) === artifact.sha256,
        "BACKUP_CORRUPT",
        "Artifact hash mismatch",
      );
    }
    const hostPath = join(state, "host/host.db");
    let hostSha256: string | null = null;
    if (existsSync(hostPath)) {
      const host = new Store(hostPath, "host");
      try {
        await backup(host.db, join(destination, "host-audit.db"));
      } finally {
        host.close();
      }
      hostSha256 = sha(readFileSync(join(destination, "host-audit.db")));
    }
    const manifest = {
      schemaVersion: 1,
      createdAt: now(),
      controlSha256: sha(readFileSync(join(destination, "control.db"))),
      hostSha256,
      artifacts,
      note: "Host snapshot is audit-only. Restore revokes authentication and keeps unfinished work unknown.",
    };
    writeFileSync(
      join(destination, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    return manifest;
  } finally {
    db.close();
  }
}

export function restoreState(source: string, destination: string) {
  invariant(
    !existsSync(destination),
    "RESTORE_EXISTS",
    "Restore requires a new state directory",
  );
  const manifest = JSON.parse(
    readFileSync(join(source, "manifest.json"), "utf8"),
  );
  invariant(
    manifest.schemaVersion === 1 &&
      sha(readFileSync(join(source, "control.db"))) === manifest.controlSha256,
    "BACKUP_CORRUPT",
    "Database manifest validation failed",
  );
  const staging = resolve(destination) + ".restore-" + uuid();
  mkdirSync(join(staging, "control"), { recursive: true, mode: 0o700 });
  let db: Store | undefined;
  try {
    copyFileSync(
      join(source, "control.db"),
      join(staging, "control/control.db"),
    );
    db = new Store(join(staging, "control/control.db"));
    invariant(
      db.get("PRAGMA integrity_check")?.integrity_check === "ok",
      "BACKUP_CORRUPT",
      "SQLite integrity check failed",
    );
    for (const row of db.all(
      "SELECT storage_key,sha256 FROM artifacts WHERE deleted_at IS NULL",
    )) {
      invariant(
        /^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(row.storage_key) &&
          manifest.artifacts.some(
            (a: any) =>
              a.storage_key === row.storage_key && a.sha256 === row.sha256,
          ),
        "BACKUP_CORRUPT",
        "Artifact manifest mismatch",
      );
      const bytes = readFileSync(join(source, "artifacts", row.storage_key));
      invariant(
        sha(bytes) === row.sha256,
        "BACKUP_CORRUPT",
        "Artifact digest mismatch",
      );
      const target = join(staging, "artifacts", row.storage_key);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
    }
    db.tx(() => {
      db!.run("DELETE FROM auth_sessions");
      db!.run("DELETE FROM login_nonces");
      db!.run("DELETE FROM idempotency_keys");
      for (const host of db!.all("SELECT id FROM hosts"))
        db!.run(
          "UPDATE hosts SET state='revoked',credential_hash=? WHERE id=?",
          sha(uuid()),
          host.id,
        );
      db!.run(
        "UPDATE agents SET desired_state='stopped',observed_state='unknown'",
      );
      db!.run(
        "UPDATE agent_sessions SET state='unknown' WHERE state NOT IN ('closed','failed')",
      );
      db!.run(
        "UPDATE runs SET state='unknown',error_code='RESTORED_REQUIRES_RECONCILIATION' WHERE state NOT IN ('completed','failed','interrupted')",
      );
      db!.run(
        "UPDATE host_commands SET state='unknown' WHERE state NOT IN ('completed','failed','cancelled')",
      );
      db!.run(
        "UPDATE operations SET state='unknown' WHERE state IN ('accepted','running')",
      );
      db!.run("UPDATE approvals SET state='unknown' WHERE state='pending'");
      db!.run(
        "UPDATE resource_projections SET state='quarantined',qualified=0,diagnostic='Restore requires original owner cleanup evidence' WHERE state<>'unavailable'",
      );
      db!.setMeta("cursor_secret", sha(uuid()));
    });
    db.close();
    db = undefined;
    renameSync(staging, destination);
    return {
      stateDir: destination,
      restored: true,
      requiresReenrollment: true,
    };
  } catch (error) {
    db?.close();
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
