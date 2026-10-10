import type { SessionSpec } from "../../../spec/contracts/runtime.js";
export type PermissionMode =
  | "read-only"
  | "ask-for-approval"
  | "auto-approve"
  | "full-access";
/** Legacy profiles retain their existing policy until explicitly changed. */
export function permissionMode(
  profile: SessionSpec["permissionProfile"],
): PermissionMode {
  if (profile === "review") return "read-only";
  if (profile === "workspace" || profile === "desktop")
    return "ask-for-approval";
  return profile;
}
export function codexPermissions(profile: SessionSpec["permissionProfile"]) {
  if (profile === "workspace" || profile === "desktop")
    return { sandbox: "workspace-write", approvalPolicy: "untrusted" } as const;
  switch (permissionMode(profile)) {
    case "read-only":
      return { sandbox: "read-only", approvalPolicy: "never" } as const;
    case "ask-for-approval":
      return { sandbox: "read-only", approvalPolicy: "on-request" } as const;
    case "auto-approve":
      return {
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      } as const;
    case "full-access":
      return {
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      } as const;
  }
}

/** Computer Use is an explicit per-agent opt-in AND requires an execution mode that permits it. */
export function computerUseAllowed(
  profile: string,
  capabilities: readonly string[],
): boolean {
  return (
    ["auto-approve", "full-access"].includes(profile) &&
    capabilities.includes("desktop.request")
  );
}
