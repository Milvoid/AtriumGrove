import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { invariant } from "../../../packages/domain/src/index.js";
const scrypt = promisify(derive);
export type AccessConfig = {
  publicUrl: string;
  allowedOrigins?: string[];
  passwordSalt: string;
  passwordHash: string;
};
export function readAccess(state: string): AccessConfig | null {
  const path = join(state, "access.json");
  if (!existsSync(path)) return null;
  const c = JSON.parse(readFileSync(path, "utf8")) as AccessConfig;
  const u = new URL(c.publicUrl);
  invariant(
    ["http:", "https:"].includes(u.protocol) &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password &&
      /^[a-f0-9]{32}$/.test(c.passwordSalt) &&
      /^[a-f0-9]{128}$/.test(c.passwordHash),
    "INVALID_ACCESS_CONFIG",
    "Invalid access configuration",
  );
  invariant(
    !c.allowedOrigins ||
      (Array.isArray(c.allowedOrigins) &&
        c.allowedOrigins.every((origin) => {
          try {
            const u = new URL(origin);
            return (
              ["http:", "https:"].includes(u.protocol) &&
              u.origin === origin &&
              !u.username &&
              !u.password
            );
          } catch {
            return false;
          }
        })),
    "INVALID_ACCESS_CONFIG",
    "Invalid allowed origins",
  );
  return c;
}
export async function configureAccess(
  state: string,
  publicUrl: string,
  password: string,
) {
  invariant(
    password.length >= 12 && password.length <= 256,
    "INVALID_PASSWORD",
    "Password must contain 12–256 characters",
  );
  const u = new URL(publicUrl);
  invariant(
    ["http:", "https:"].includes(u.protocol) &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password,
    "INVALID_URL",
    "Use a public origin without a path or credentials",
  );
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const path = join(state, "access.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        publicUrl: u.origin,
        passwordSalt: salt,
        passwordHash: hash.toString("hex"),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}
export async function verifyPassword(c: AccessConfig, password: unknown) {
  if (typeof password !== "string" || password.length > 256) return false;
  const actual = (await scrypt(password, c.passwordSalt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(c.passwordHash, "hex"));
}
export function checkOrigin(
  host: string,
  origin: string | undefined,
  c: AccessConfig | null,
) {
  let target: URL;
  try {
    target = new URL("http://" + host);
  } catch {
    return false;
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
  const configured = configuredOrigin(host, c);
  if (!local && !configured) return false;
  if (!origin) return true;
  return origin === (configured ?? target.origin);
}
export function configuredOrigin(host: string, c: AccessConfig | null) {
  return c
    ? [c.publicUrl, ...(c.allowedOrigins ?? [])].find(
        (origin) => new URL(origin).host === host,
      )
    : undefined;
}
