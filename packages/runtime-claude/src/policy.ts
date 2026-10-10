import { existsSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionSpec } from "../../../spec/contracts/runtime.js";
import { toolCapability } from "../../contracts/src/index.js";
import { permissionMode } from "../../runtime-common/src/permissions.js";

export function claudePermissions(
  spec: SessionSpec,
): Pick<
  Options,
  "permissionMode" | "allowDangerouslySkipPermissions" | "sandbox"
> {
  switch (permissionMode(spec.permissionProfile)) {
    case "read-only":
      return { permissionMode: "plan" };
    case "ask-for-approval":
      return { permissionMode: "default" };
    case "auto-approve":
      return {
        permissionMode: "acceptEdits",
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
        },
      };
    case "full-access":
      return {
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        sandbox: { enabled: false },
      };
  }
}
/** Hooks still run for cached native approvals. Undefined delegates to native policy. */
export function toolDecision(
  spec: SessionSpec,
  name: string,
  args: Record<string, unknown>,
): "allow" | "ask" | "deny" | undefined {
  if (["Agent", "Task"].includes(name)) return "deny"; // Child relay identity is not supported.
  const mode = permissionMode(spec.permissionProfile);
  if (name.startsWith("mcp__harbor_computer__"))
    return ["auto-approve", "full-access"].includes(mode) &&
      spec.mcpServers.some((s) => s.name === "harbor_computer") &&
      ["mcp__harbor_computer__js", "mcp__harbor_computer__js_reset"].includes(
        name,
      )
      ? "allow"
      : "deny";
  const platform =
    name.startsWith("mcp__harbor__") &&
    spec.mcpServers.some((s) => s.name === "harbor") &&
    name.slice("mcp__harbor__".length) in toolCapability;
  if (platform) return "allow"; // Relay separately checks capabilities and desktop grants.
  if (name.startsWith("mcp__")) return "deny"; // Never inherit an unmanaged Computer Use bridge.
  if (name === "AskUserQuestion") return "ask";
  if (mode === "full-access") return undefined;
  const read = ["Read", "Glob", "Grep"].includes(name);
  if (mode === "read-only" && !read) return "deny";
  const path = args.file_path ?? args.path ?? args.notebook_path;
  if (typeof path === "string") {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return "deny";
    let existing = resolve(spec.workspacePath, path);
    while (!existsSync(existing) && dirname(existing) !== existing)
      existing = dirname(existing);
    const rel = relative(
      realpathSync(spec.workspacePath),
      realpathSync(existing),
    );
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return "deny";
  }
  if (read) return "allow";
  if (mode === "auto-approve") {
    // Never short-circuit Bash: the native sandbox must authorize it.
    if (["Write", "Edit", "NotebookEdit", "Bash"].includes(name))
      return undefined;
  }
  return "ask";
}
