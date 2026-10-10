import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha, canonical, uuid } from "../../persistence/src/index.js";
import { invariant } from "../../domain/src/index.js";
import type {
  ComputerUseProvider,
  DesktopContext,
  DesktopConnection,
  ApprovalRequest,
  HumanDecision,
} from "../../../spec/contracts/runtime.js";
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () =>
      reject(signal.reason ?? new Error("Computer operation aborted"));
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}
export interface LcuConfig {
  clientModule: string;
  command: string[];
  clientSha256: string;
  providerVersion: string;
  runtimeFiles?: string[];
  approvalHostBundleId?: string;
  qualification?: {
    runtimeFingerprint: string;
    instructionsSha256: string;
    toolSchemaSha256: string;
    cleanupConfirmed: boolean;
    humanControlHostExcluded: boolean;
  };
}
export class LcuProvider implements ComputerUseProvider {
  readonly id = "lcu" as const;
  instructions = "";
  publicTools: any[] = [];
  constructor(readonly config: LcuConfig) {}
  fingerprint() {
    return sha(
      canonical(
        (this.config.runtimeFiles ?? [this.config.command[0]!]).map((path) => ({
          path: realpathSync(path),
          sha256: sha(readFileSync(realpathSync(path))),
        })),
      ),
    );
  }
  assertExclusion() {
    // Only the native-forbidden Codex desktop host is currently qualified. Browser
    // profiles share an application permission and are deliberately insufficient.
    invariant(
      this.config.approvalHostBundleId === "com.openai.codex",
      "APPROVAL_HOST_UNVERIFIED",
      "Open the approval UI in the Codex desktop host; browser-host exclusion is not qualified",
    );
    invariant(
      !this.config.command.includes("--chrome"),
      "APPROVAL_HOST_UNVERIFIED",
      "Browser surface must remain disabled for this qualification",
    );
    const path = join(
      homedir(),
      "Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json",
    );
    const grants = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8")).approvedBundleIdentifiers
      : [];
    invariant(
      Array.isArray(grants) &&
        grants.every((x) => typeof x === "string") &&
        !grants.includes(this.config.approvalHostBundleId),
      "APPROVAL_HOST_GRANTED",
      "Approval host grant must be reviewed and revoked by the human",
    );
  }
  private async client(onElicitation: (p: any) => Promise<any>) {
    invariant(
      sha(readFileSync(realpathSync(this.config.clientModule))) ===
        this.config.clientSha256,
      "NATIVE_SCHEMA_MISMATCH",
      "LCU client changed",
    );
    const module = await import(pathToFileURL(this.config.clientModule).href);
    const client = module.createCuaClient({
      command: this.config.command,
      onElicitation,
      adapter: "harbor",
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
  async probe() {
    const c = await this.client(async () => ({ action: "cancel" }));
    try {
      const runtimeFingerprint = this.fingerprint();
      const instructionsSha256 = sha(c.instructions),
        toolSchemaSha256 = sha(canonical(c.publicTools()));
      this.instructions = c.instructions;
      this.publicTools = c.publicTools();
      const diagnostics: string[] = [];
      try {
        this.assertExclusion();
      } catch (e) {
        diagnostics.push(String(e));
      }
      const q = this.config.qualification;
      return {
        available: true,
        providerVersion: this.config.providerVersion,
        runtimeFingerprint,
        instructionsSha256,
        toolSchemaSha256,
        interactiveApprovals: true,
        cleanup:
          q?.cleanupConfirmed &&
          q.runtimeFingerprint === runtimeFingerprint &&
          q.instructionsSha256 === instructionsSha256 &&
          q.toolSchemaSha256 === toolSchemaSha256
            ? ("confirmed" as const)
            : ("unverified" as const),
        diagnostics,
      };
    } finally {
      await c.close();
    }
  }
  async open(
    onApproval: (r: ApprovalRequest) => Promise<HumanDecision>,
    context: DesktopContext,
    signal: AbortSignal,
  ): Promise<DesktopConnection> {
    this.assertExclusion();
    invariant(
      this.config.qualification?.runtimeFingerprint === this.fingerprint(),
      "PROVIDER_CHANGED",
      "Original runtime changed; repeat qualification",
    );
    const original = await import(pathToFileURL(this.config.clientModule).href);
    const c = await this.client(async (p) => {
      const app = p?._meta?.tool_params?.app;
      if (app === this.config.approvalHostBundleId)
        return { action: "decline" };
      const id = uuid(),
        hash = sha(canonical(p));
      signal.throwIfAborted();
      const decision = await onApproval({
        approvalId: id,
        runId: context.runId,
        launchId: context.launchId,
        nativeRequestId: id,
        source: "computer-use",
        kind: p.mode === "url" ? "url" : "form",
        title: p.message ?? "Computer Use permission",
        inputSchema: p.requestedSchema ?? {},
        display: p,
        allowedActions: ["approve", "deny", "cancel"],
        argumentHash: hash,
      });
      const native = original.nativeAppApprovalOptions(p);
      if (native)
        return original.nativeAppApprovalResponse(
          p,
          decision.action === "approve"
            ? decision.scope === "session"
              ? "session"
              : "once"
            : decision.action === "deny"
              ? "decline"
              : "cancel",
        );
      return {
        action:
          decision.action === "approve"
            ? "accept"
            : decision.action === "deny"
              ? "decline"
              : "cancel",
        ...(decision.content ? { content: decision.content } : {}),
      };
    });
    try {
      invariant(
        sha(c.instructions) === this.config.qualification?.instructionsSha256 &&
          sha(canonical(c.publicTools())) ===
            this.config.qualification?.toolSchemaSha256,
        "PROVIDER_CHANGED",
        "Provider instructions or tool schema changed",
      );
      signal.throwIfAborted();
    } catch (error) {
      await c.close();
      throw error;
    }
    return {
      instructions: c.instructions,
      publicTools: c.publicTools(),
      invoke: (name, args, ctx, signal) => {
        this.assertExclusion();
        invariant(
          this.config.qualification?.runtimeFingerprint === this.fingerprint(),
          "PROVIDER_CHANGED",
          "Runtime updated during turn",
        );
        return c.call(name, args, {
          sessionId: ctx.hostSessionId,
          turnId: ctx.hostTurnId,
          signal,
        });
      },
      endTurn: async (ctx, reason, cleanupSignal) => {
        const receipt = await bounded<any>(
          c.turnEnded({
            sessionId: ctx.hostSessionId,
            turnId: ctx.hostTurnId,
            event: reason === "Stop" ? "Stop" : "Interrupt",
          }),
          cleanupSignal,
        );
        return {
          quiescent: !!receipt && !receipt.isError,
          receipt: receipt ?? null,
        };
      },
      close: (closeSignal) => bounded(c.close(), closeSignal),
    };
  }
}
