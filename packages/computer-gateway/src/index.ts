import type {
  ComputerUseProvider,
  DesktopConnection,
  DesktopContext,
  HumanDecision,
  ApprovalRequest,
  JsonObject,
} from "../../../spec/contracts/runtime.js";
import {
  Store,
  uuid,
  sha,
  canonical,
  now,
} from "../../persistence/src/index.js";
import { setTimeout as delay } from "node:timers/promises";
import { invariant } from "../../domain/src/index.js";
export class ComputerGateway {
  private connection: DesktopConnection | null = null;
  private controller: AbortController | null = null;
  private context: DesktopContext | null = null;
  private opening: Promise<DesktopContext> | null = null;
  private draining: Promise<boolean> | null = null;
  private inflight = new Set<Promise<unknown>>();
  constructor(
    readonly db: Store,
    readonly resourceId: string,
    readonly provider: ComputerUseProvider | null,
  ) {
    db.run(
      "INSERT OR IGNORE INTO desktop_resources(resource_id,state,provider) VALUES (?,'unavailable',?)",
      resourceId,
      provider?.id ?? "disabled",
    );
    db.run(
      "UPDATE desktop_resources SET provider=? WHERE resource_id=?",
      provider?.id ?? "disabled",
      resourceId,
    );
    db.run(
      "UPDATE desktop_resources SET state='unavailable',diagnostic='Provider qualification pending' WHERE resource_id=? AND state='free'",
      resourceId,
    );
    db.run(
      "UPDATE desktop_resources SET state='quarantined',diagnostic='Host restarted; cleanup unverified' WHERE resource_id=? AND state IN ('held','draining')",
      resourceId,
    );
  }
  state() {
    return this.db.get(
      "SELECT * FROM desktop_resources WHERE resource_id=?",
      this.resourceId,
    )!;
  }
  async qualify(humanHostExcluded: boolean) {
    invariant(
      this.provider,
      "PROVIDER_UNAVAILABLE",
      "Computer provider not installed",
    );
    const q = await this.provider.probe(AbortSignal.timeout(30000));
    invariant(
      q.available &&
        q.cleanup === "confirmed" &&
        q.interactiveApprovals &&
        q.diagnostics.length === 0 &&
        humanHostExcluded,
      "PROVIDER_UNQUALIFIED",
      "Provider and approval host exclusion must be verified",
    );
    this.db.run(
      "UPDATE desktop_resources SET state='free',diagnostic=NULL WHERE resource_id=? AND state='unavailable'",
      this.resourceId,
    );
    return q;
  }
  async acquire(
    context: Omit<DesktopContext, "leaseEpoch">,
    onApproval: (r: ApprovalRequest) => Promise<HumanDecision>,
    options: { signal?: AbortSignal; waitMs?: number } = {},
  ): Promise<DesktopContext> {
    const deadline = Date.now() + (options.waitMs ?? 30000);
    let state = this.state();
    while (
      ["held", "draining"].includes(state.state) &&
      state.owner_run_id !== context.runId &&
      Date.now() < deadline
    ) {
      await delay(
        Math.min(100, Math.max(1, deadline - Date.now())),
        undefined,
        { signal: options.signal },
      );
      state = this.state();
    }
    options.signal?.throwIfAborted();
    if (
      state.owner_run_id === context.runId &&
      state.owner_launch_id === context.launchId &&
      state.state === "held"
    )
      return this.opening ?? this.context!;
    invariant(
      state.state === "free",
      "DESKTOP_BUSY",
      `Desktop ${state.state}; owner run: ${state.owner_run_id ?? "none"}`,
      409,
    );
    const epoch = this.db.tx(() => {
      const r = this.db.run(
        "UPDATE desktop_resources SET state='held',lease_epoch=lease_epoch+1,owner_launch_id=?,owner_run_id=?,expires_wall_ms=? WHERE resource_id=? AND state='free'",
        context.launchId,
        context.runId,
        Date.now() + 60000,
        this.resourceId,
      );
      invariant(
        r.changes === 1,
        "DESKTOP_BUSY",
        "Desktop was acquired by another owner",
      );
      return this.state().lease_epoch;
    });
    this.context = { ...context, leaseEpoch: epoch };
    this.controller = new AbortController();
    this.opening = (async () => {
      try {
        this.connection = await this.provider!.open(
          onApproval,
          this.context!,
          this.controller!.signal,
        );
        return this.context!;
      } catch (e) {
        this.quarantine(String(e));
        throw e;
      }
    })();
    try {
      return await this.opening;
    } finally {
      this.opening = null;
    }
  }

  async call(name: string, args: JsonObject, context: DesktopContext) {
    const state = this.state();
    invariant(
      this.connection &&
        state.state === "held" &&
        state.owner_run_id === context.runId &&
        state.owner_launch_id === context.launchId &&
        state.lease_epoch === context.leaseEpoch,
      "STALE_LEASE",
      "Desktop binding expired",
      409,
    );
    invariant(
      ["js", "js_reset"].includes(name),
      "HOST_ONLY_TOOL",
      "Lifecycle tool is not model-visible",
      403,
    );
    const id = uuid();
    this.db.run(
      "INSERT INTO desktop_calls(call_id,resource_id,launch_id,run_id,lease_epoch,method,argument_hash,state,started_at) VALUES (?,?,?,?,?,?,?,'executing',?)",
      id,
      this.resourceId,
      context.launchId,
      context.runId,
      context.leaseEpoch,
      name,
      sha(canonical(args)),
      now(),
    );
    this.db.run(
      "UPDATE desktop_resources SET pending_calls=pending_calls+1 WHERE resource_id=?",
      this.resourceId,
    );
    const promise = Promise.resolve().then(() =>
      this.connection!.invoke(name, args, context, this.controller!.signal),
    );
    this.inflight.add(promise);
    try {
      const result = await promise;
      this.db.run(
        "UPDATE desktop_calls SET state=?,ended_at=? WHERE call_id=?",
        result.isError ? "failed" : "completed",
        now(),
        id,
      );
      return result;
    } catch (e) {
      this.db.run(
        "UPDATE desktop_calls SET state='unknown' WHERE call_id=?",
        id,
      );
      this.quarantine(String(e));
      throw e;
    } finally {
      this.inflight.delete(promise);
      this.db.run(
        "UPDATE desktop_resources SET pending_calls=pending_calls-1 WHERE resource_id=?",
        this.resourceId,
      );
    }
  }
  async drain(
    runId: string,
    reason: "Stop" | "Interrupted" | "Shutdown" = "Stop",
  ) {
    if (this.state().owner_run_id !== runId) return true;
    if (this.draining) return this.draining;
    this.draining = this.finishDrain(runId, reason);
    try {
      return await this.draining;
    } finally {
      this.draining = null;
    }
  }
  private async finishDrain(
    runId: string,
    reason: "Stop" | "Interrupted" | "Shutdown",
  ) {
    if (this.opening) {
      try {
        await this.opening;
      } catch {}
    }
    if (!this.connection || !this.context) {
      this.quarantine("Lost provider connection");
      return false;
    }
    this.db.run(
      "UPDATE desktop_resources SET state='draining' WHERE resource_id=? AND state='held'",
      this.resourceId,
    );
    try {
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Desktop calls did not drain")),
            30000,
          ).unref(),
        ),
      ]);
      const receipt = await this.connection.endTurn(
        this.context,
        reason,
        AbortSignal.timeout(30000),
      );
      invariant(
        receipt.quiescent && this.inflight.size === 0,
        "DESKTOP_STOP_UNCONFIRMED",
        "Cleanup not confirmed",
      );
      await this.connection.close(AbortSignal.timeout(10000));
      this.db.run(
        "UPDATE desktop_resources SET state='free',owner_launch_id=NULL,owner_run_id=NULL,pending_calls=0,last_cleanup_receipt=?,diagnostic=NULL WHERE resource_id=?",
        JSON.stringify(receipt),
        this.resourceId,
      );
      this.connection = null;
      this.context = null;
      return true;
    } catch (e) {
      this.quarantine(String(e));
      return false;
    }
  }
  stop(runId?: string) {
    if (runId && this.state().owner_run_id !== runId) return;
    this.controller?.abort();
    this.db.run(
      "UPDATE desktop_resources SET state='draining',diagnostic='Stop requested; awaiting terminal and cleanup' WHERE resource_id=? AND state='held'",
      this.resourceId,
    );
  }
  quarantine(reason: string) {
    this.db.run(
      "UPDATE desktop_resources SET state='quarantined',diagnostic=? WHERE resource_id=?",
      reason,
      this.resourceId,
    );
  }
  async clear() {
    invariant(
      this.state().state === "quarantined",
      "INVALID_STATE",
      "Desktop not quarantined",
    );
    invariant(
      this.connection && this.context && this.inflight.size === 0,
      "DESKTOP_STOP_UNCONFIRMED",
      "Cannot prove prior owner is quiescent",
    );
    return this.drain(this.context.runId, "Interrupted");
  }
}
