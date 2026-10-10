import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  randomUUID,
  createHash,
  randomBytes,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { DomainError, invariant } from "../../domain/src/index.js";
export type Row = Record<string, any>;
export const now = () => new Date().toISOString();
export const uuid = () => randomUUID();
export const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    invariant(
      typeof value !== "number" || Number.isFinite(value),
      "INVALID_NUMBER",
      "Nonfinite JSON",
    );
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const compare = (a: string, b: string) => {
    const aa = Array.from(a, (x) => x.codePointAt(0)!),
      bb = Array.from(b, (x) => x.codePointAt(0)!);
    for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
      if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
    }
    return aa.length - bb.length;
  };
  return (
    "{" +
    Object.keys(value)
      .filter((k) => (value as Row)[k] !== undefined)
      .sort(compare)
      .map((k) => JSON.stringify(k) + ":" + canonical((value as Row)[k]))
      .join(",") +
    "}"
  );
}
export function equalSecret(a: string, b: string) {
  const aa = Buffer.from(a),
    bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export class Store {
  readonly db: DatabaseSync;
  constructor(
    public path: string,
    public kind: "control" | "host" = "control",
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    const exists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE name=?")
      .get(kind === "control" ? "schema_migrations" : "host_meta");
    if (!exists)
      this.db.exec(
        readFileSync(
          new URL(
            `../../../spec/db/${kind === "control" ? "schema" : "host"}.sql`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS harbor_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);",
    );
    if (
      kind === "control" &&
      !this.get("SELECT value FROM harbor_meta WHERE key='extension_version'")
    )
      this.tx(() => {
        this.db.exec(
          readFileSync(
            new URL("../migrations/002-implementation.sql", import.meta.url),
            "utf8",
          ),
        );
        this.setMeta("extension_version", "1");
        this.run("INSERT OR IGNORE INTO schema_migrations VALUES (2,?)", now());
      });
    if (
      kind === "control" &&
      !this.get("SELECT version FROM schema_migrations WHERE version=3")
    )
      this.tx(() => {
        this.db.exec(
          readFileSync(
            new URL("../migrations/003-project-mode.sql", import.meta.url),
            "utf8",
          ),
        );
        this.run("INSERT INTO schema_migrations VALUES (3,?)", now());
      });
    if (
      kind === "control" &&
      !this.get("SELECT version FROM schema_migrations WHERE version=4")
    )
      this.tx(() => {
        this.db.exec(
          readFileSync(
            new URL(
              "../migrations/004-conversation-directory.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        this.run("INSERT INTO schema_migrations VALUES (4,?)", now());
      });
    if (
      kind === "control" &&
      !this.get("SELECT version FROM schema_migrations WHERE version=5")
    )
      this.tx(() => {
        this.db.exec(
          readFileSync(
            new URL("../migrations/005-agent-deletion.sql", import.meta.url),
            "utf8",
          ),
        );
        this.run("INSERT INTO schema_migrations VALUES (5,?)", now());
      });
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  run(sql: string, ...params: SQLInputValue[]) {
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    const result = statement.run(...params);
    return { ...result, changes: Number(result.changes) };
  }
  private integers(row: Row): Row {
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "bigint"
          ? value <= BigInt(Number.MAX_SAFE_INTEGER) &&
            value >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(value)
            : value.toString()
          : value,
      ]),
    );
  }
  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    const row = statement.get(...params);
    return row ? this.integers(row) : undefined;
  }
  all(sql: string, ...params: SQLInputValue[]): Row[] {
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...params).map((row) => this.integers(row));
  }
  seq(sql: string, ...params: SQLInputValue[]): string {
    const statement = this.db.prepare(sql);
    statement.setReadBigInts(true);
    const row = statement.get(...params);
    return String(row ? (Object.values(row)[0] ?? 0) : 0);
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  read<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  meta(key: string) {
    return this.get("SELECT value FROM harbor_meta WHERE key=?", key)?.value as
      | string
      | undefined;
  }
  setMeta(key: string, value: string) {
    this.run(
      "INSERT INTO harbor_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
  }
  entity(table: string, id: string): Row {
    invariant(/^[a-z_]+$/.test(table), "BAD_TABLE", "Invalid table");
    const row = this.get(`SELECT * FROM ${table} WHERE id=?`, id);
    invariant(row, "NOT_FOUND", `${table} not found`, 404);
    return row;
  }
  close() {
    this.db.close();
  }
}
export class Cursor {
  constructor(private secret: string) {}
  encode(
    workspaceId: string,
    collection: string,
    filter: unknown,
    lastSortKey: string,
    lastId: string,
  ) {
    const payload = Buffer.from(
      canonical({
        version: 1,
        workspaceId,
        collection,
        filterHash: sha(canonical(filter)),
        lastSortKey,
        lastId,
      }),
    ).toString("base64url");
    return (
      payload +
      "." +
      createHmac("sha256", this.secret).update(payload).digest("base64url")
    );
  }
  decode(
    cursor: string,
    workspaceId: string,
    collection: string,
    filter: unknown,
  ): Row {
    try {
      const [payload, sig] = cursor.split(".");
      invariant(payload && sig, "INVALID_CURSOR", "Invalid cursor", 400);
      invariant(
        equalSecret(
          createHmac("sha256", this.secret).update(payload).digest("base64url"),
          sig,
        ),
        "INVALID_CURSOR",
        "Invalid cursor signature",
        400,
      );
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString());
      invariant(
        parsed.version === 1 &&
          parsed.workspaceId === workspaceId &&
          parsed.collection === collection &&
          parsed.filterHash === sha(canonical(filter)),
        "INVALID_CURSOR",
        "Cursor scope mismatch",
        400,
      );
      return parsed;
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError("INVALID_CURSOR", "Invalid cursor", 400);
    }
  }
}
export class Auth {
  readonly owner: string;
  readonly system: string;
  constructor(readonly store: Store) {
    this.owner = this.ensure("human", "Owner");
    this.system = this.ensure("system", "Atrium Grove");
    this.store.run(
      "UPDATE principals SET display_name=? WHERE id=? AND display_name<>?",
      "Atrium Grove",
      this.system,
      "Atrium Grove",
    );
    if (!store.meta("cursor_secret"))
      store.setMeta("cursor_secret", randomBytes(32).toString("hex"));
  }
  private ensure(kind: string, name: string) {
    const old = this.store.get("SELECT id FROM principals WHERE kind=?", kind);
    if (old) return old.id as string;
    const id = uuid();
    this.store.run(
      "INSERT INTO principals VALUES (?,?,?,?)",
      id,
      kind,
      name,
      now(),
    );
    return id;
  }
  nonce() {
    const token = randomBytes(32).toString("base64url");
    this.store.run(
      "INSERT INTO login_nonces VALUES (?,?,NULL)",
      sha(token),
      new Date(Date.now() + 300000).toISOString(),
    );
    return token;
  }
  exchange(token: string) {
    return this.store.tx(() => {
      const row = this.store.get(
        "SELECT * FROM login_nonces WHERE token_hash=?",
        sha(token),
      );
      invariant(
        row && !row.consumed_at && row.expires_at > now(),
        "INVALID_LOGIN",
        "Login token expired or consumed",
        401,
      );
      this.store.run(
        "UPDATE login_nonces SET consumed_at=? WHERE token_hash=?",
        now(),
        sha(token),
      );
      const session = randomBytes(32).toString("base64url"),
        csrf = randomBytes(32).toString("base64url");
      this.store.run(
        "INSERT INTO auth_sessions VALUES (?,?,?,?,NULL)",
        sha(session),
        this.owner,
        sha(csrf),
        new Date(Date.now() + 86400000).toISOString(),
      );
      return { session, csrf };
    });
  }
  session(token: string | undefined, csrf?: string) {
    invariant(token, "UNAUTHENTICATED", "Login required", 401);
    const row = this.store.get(
      "SELECT * FROM auth_sessions WHERE token_hash=?",
      sha(token),
    );
    invariant(
      row && !row.revoked_at && row.expires_at > now(),
      "UNAUTHENTICATED",
      "Session expired",
      401,
    );
    if (csrf !== undefined)
      invariant(
        equalSecret(row.csrf_hash, sha(csrf)),
        "CSRF_INVALID",
        "CSRF token required",
        403,
      );
    return row;
  }
  logout(token: string) {
    this.store.run(
      "UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?",
      now(),
      sha(token),
    );
  }
}
