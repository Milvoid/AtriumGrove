import {
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  renameSync,
  readFileSync,
  existsSync,
  realpathSync,
  statSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, relative, isAbsolute, dirname } from "node:path";
import {
  sha,
  uuid,
  now,
  Store,
  type Row,
} from "../../persistence/src/index.js";
import { invariant } from "../../domain/src/index.js";
export function safePath(root: string, path: string) {
  const resolved = realpathSync(path),
    rel = relative(realpathSync(root), resolved);
  invariant(
    rel !== ".." &&
      !rel.startsWith("../") &&
      !rel.startsWith("..\\") &&
      !isAbsolute(rel),
    "PATH_DENIED",
    "Path outside allowed root",
    403,
  );
  return resolved;
}
export function mime(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return "text/plain";
}
export class Artifacts {
  constructor(
    readonly root: string,
    readonly store: Store,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  put(
    workspaceId: string,
    creatorId: string,
    bytes: Buffer,
    filename: string,
    kind = "file",
    privateRunId: string | null = null,
    provenance: Row = {},
  ) {
    return this.record(
      workspaceId,
      creatorId,
      this.stage(bytes, filename),
      kind,
      privateRunId,
      provenance,
    );
  }
  /** Finish file IO before entering the short metadata transaction. */
  stage(bytes: Buffer, filename: string) {
    invariant(
      bytes.length <= 25 * 1024 * 1024,
      "ARTIFACT_TOO_LARGE",
      "Artifact exceeds 25 MiB",
      413,
    );
    invariant(
      filename.length > 0 && !/[\r\n\x00/\\]/.test(filename),
      "INVALID_FILENAME",
      "Filename must be a basename",
      400,
    );
    const digest = sha(bytes),
      storage = join(digest.slice(0, 2), digest);
    mkdirSync(dirname(join(this.root, storage)), {
      recursive: true,
      mode: 0o700,
    });
    if (!existsSync(join(this.root, storage))) {
      const tmp = join(this.root, uuid() + ".tmp"),
        fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, join(this.root, storage));
      const dir = openSync(dirname(join(this.root, storage)), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
    return {
      digest,
      storage,
      filename,
      mimeType: mime(bytes),
      size: bytes.length,
    };
  }
  record(
    workspaceId: string,
    creatorId: string,
    staged: ReturnType<Artifacts["stage"]>,
    kind = "file",
    privateRunId: string | null = null,
    provenance: Row = {},
  ) {
    const { digest, storage, filename, mimeType, size } = staged;
    const id = uuid();
    this.store.run(
      "INSERT INTO artifacts(id,workspace_id,creator_id,kind,filename,mime_type,size_bytes,sha256,storage_key,retention_class,created_at,provenance_json,private_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      workspaceId,
      creatorId,
      kind,
      filename,
      mimeType,
      size,
      digest,
      storage,
      kind === "context"
        ? "diagnostic"
        : kind === "image"
          ? "screenshot"
          : "durable",
      now(),
      JSON.stringify(provenance),
      privateRunId,
    );
    return id;
  }
  collectOrphans(olderThanMs = 86400000) {
    const referenced = new Set(
      this.store
        .all("SELECT storage_key FROM artifacts")
        .map((r) => r.storage_key),
    );
    let removed = 0;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      const paths = entry.isDirectory()
        ? readdirSync(join(this.root, entry.name)).map((n) =>
            join(entry.name, n),
          )
        : [entry.name];
      for (const path of paths) {
        const full = join(this.root, path);
        if (
          !referenced.has(path) &&
          statSync(full).isFile() &&
          Date.now() - statSync(full).mtimeMs > olderThanMs
        ) {
          unlinkSync(full);
          removed++;
        }
      }
    }
    return removed;
  }
  read(id: string, workspaceId: string, runId?: string) {
    const artifact = this.store.entity("artifacts", id);
    invariant(
      artifact.workspace_id === workspaceId && !artifact.deleted_at,
      "ARTIFACT_DENIED",
      "Artifact not accessible",
      403,
    );
    invariant(
      !artifact.private_run_id ||
        runId === artifact.private_run_id ||
        runId === "owner",
      "ARTIFACT_DENIED",
      "Private context artifact",
      403,
    );
    const bytes = readFileSync(
      safePath(this.root, join(this.root, artifact.storage_key)),
    );
    invariant(
      sha(bytes) === artifact.sha256,
      "ARTIFACT_CORRUPT",
      "Artifact hash mismatch",
    );
    return { artifact, bytes };
  }
  register(
    root: string,
    path: string,
    workspace: string,
    actor: string,
    filename: string,
    kind: string,
  ) {
    invariant(
      !path.startsWith("file:"),
      "PATH_DENIED",
      "Use a filesystem path",
    );
    const p = safePath(root, path);
    invariant(statSync(p).isFile(), "PATH_DENIED", "Regular file required");
    return this.put(workspace, actor, readFileSync(p), filename, kind);
  }
}
