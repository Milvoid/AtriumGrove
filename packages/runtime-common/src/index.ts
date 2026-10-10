import { createRequire } from "node:module";
import {
  readFileSync,
  realpathSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { canonical, sha } from "../../persistence/src/index.js";

export function executablePath(path: string) {
  const real = realpathSync(path);
  if (real.endsWith("/@openai/codex/bin/codex.js")) {
    const target =
      process.platform === "darwin"
        ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
        : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
    const require = createRequire(real);
    const pkg = require.resolve(
      `@openai/codex-${process.platform}-${process.arch}/package.json`,
    );
    return realpathSync(join(dirname(pkg), "vendor", target, "bin", "codex"));
  }
  return real;
}
export function processIdentity(pid: number) {
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 2000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}
export function processGroupAlive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function stopOwnedProcess(
  pid: number,
  startedAt: string | null,
  signal: AbortSignal,
) {
  const observed = processIdentity(pid);
  if (!observed) return !processGroupAlive(pid);
  if (!startedAt || observed !== startedAt) return false;
  process.kill(-pid, "SIGTERM");
  while (!signal.aborted && processGroupAlive(pid))
    await new Promise((r) => setTimeout(r, 50));
  return !processGroupAlive(pid);
}
/** Persist unknown native payloads locally; credentials are never part of exported traces. */
export function nativeDiagnostic(
  directory: string | undefined,
  value: unknown,
) {
  const redact = (v: any): any =>
    Array.isArray(v)
      ? v.map(redact)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) => [
              k,
              /token|secret|credential|authorization|api.key/i.test(k)
                ? "[redacted]"
                : redact(x),
            ]),
          )
        : v;
  const raw = canonical(redact(value)),
    digest = sha(raw);
  if (!directory) return `unavailable://${digest}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, digest + ".json");
  if (!existsSync(path)) writeFileSync(path, raw, { mode: 0o600 });
  return `host-diagnostic://${digest}`;
}
