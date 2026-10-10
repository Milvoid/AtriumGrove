import {
  codexToolInput,
  codexToolResult,
} from "../../runtime-common/src/telemetry.js";
import { codexPermissions } from "../../runtime-common/src/permissions.js";
import { validateNativeRequest } from "./schema.js";
import {
  nativeDiagnostic,
  processGroupAlive,
} from "../../runtime-common/src/index.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { uuid, sha, canonical } from "../../persistence/src/index.js";
import { invariant, DomainError } from "../../domain/src/index.js";
import type {
  SessionSpec,
  HarnessSession,
  RuntimeEvent,
  RunInput,
  HumanDecision,
  RuntimeCapabilities,
} from "../../../spec/contracts/runtime.js";
export const codexCapabilities: RuntimeCapabilities = {
  streaming: true,
  resume: "native",
  interrupt: "native",
  steering: "native",
  acknowledgements: "request_receipt",
  permissions: "interactive",
  mcp: true,
  images: true,
  backgroundTaskTracking: "partial",
  nativeToolInventory: "available",
};
export class CodexSession implements HarnessSession {
  readonly capabilities = codexCapabilities;
  nativeSessionId: string | null = null;
  nativeModel: string | null = null;
  get processId() {
    return this.child?.pid;
  }
  private child!: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private seq = 0;
  private current: RunInput | null = null;
  private nativeTurn: string | null = null;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private approvals = new Map<
    string,
    { id: string | number; method: string; hash: string }
  >();
  private projection = Promise.resolve();
  constructor(
    readonly spec: SessionSpec,
    private onEvent: (e: RuntimeEvent) => Promise<void>,
  ) {}
  private emit(body: any) {
    return this.onEvent({
      ...body,
      launchId: this.spec.launchId,
      producerSeq: ++this.seq,
      agentId: this.spec.agentId,
      sessionId: this.spec.sessionId,
      runId: this.current?.runId ?? null,
      nativeThreadId: this.nativeSessionId ?? undefined,
      nativeTurnId: this.nativeTurn ?? undefined,
      lane: [],
      occurredAt: new Date().toISOString(),
    });
  }
  async initialize() {
    invariant(
      sha(readFileSync(realpathSync(this.spec.executable.realPath))) ===
        this.spec.executable.sha256,
      "NATIVE_SCHEMA_MISMATCH",
      "Codex binary changed",
    );
    const mcp = Object.fromEntries(
      this.spec.mcpServers.map((s) => [
        s.name,
        { command: s.command, args: s.args, env: s.env },
      ]),
    );
    // Atrium Grove owns computer access. Do not inherit the desktop app's parallel
    // computer/browser/plugin bridges, which would bypass per-agent switches.
    const args = [
      "--disable",
      "computer_use",
      "--disable",
      "browser_use",
      "--disable",
      "plugins",
      "--disable",
      "apps",
      "app-server",
      "--listen",
      "stdio://",
    ];
    this.child = spawn(this.spec.executable.realPath, args, {
      cwd: this.spec.workspacePath,
      stdio: "pipe",
      detached: true,
      env: { ...process.env },
    });
    let buffered = 0;
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.length;
      if (buffered > 16 * 1024 * 1024) {
        this.child.kill();
      }
      if (chunk.includes(10))
        buffered = chunk.length - chunk.lastIndexOf(10) - 1;
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.projection = this.projection
        .then(async () => {
          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            throw new DomainError("NATIVE_PROTOCOL", "Invalid native JSON");
          }
          await this.message(message);
        })
        .catch(async (error) => {
          await this.emit({
            kind: "diagnostic",
            code: "NATIVE_PROTOCOL",
            message: String(error),
            severity: "error",
          });
        });
    });
    this.child.stderr.on("data", () => {});
    this.child.on("error", (e) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this.pending.clear();
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(
          new DomainError("SUBMISSION_UNKNOWN", "Native process exited"),
        );
      }
      this.pending.clear();
      void this.emit({
        kind: "process.exited",
        code,
        signal,
        expected: !this.current,
      });
    });
    await this.rpc("initialize", {
      clientInfo: { name: "harbor", title: "Atrium Grove", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized", params: {} });
    const inherited = await this.rpc("config/read", {
      cwd: this.spec.workspacePath,
      includeLayers: false,
    });
    const inheritedMcp = Object.fromEntries(
      Object.keys(inherited.config?.mcp_servers ?? {}).map((name) => [
        name,
        { enabled: false },
      ]),
    );
    const params: any = {
      cwd: this.spec.workspacePath,
      ...codexPermissions(this.spec.permissionProfile),
      developerInstructions: this.spec.standingInstructions,
      config: {
        mcp_servers: { ...inheritedMcp, ...mcp },
        "sandbox_workspace_write.network_access": false,
        "features.multi_agent": false,
        "features.computer_use": false,
        "features.browser_use": false,
        "features.plugins": false,
        "features.apps": false,
      },
    };
    if (this.spec.model !== "default") params.model = this.spec.model;
    if (this.spec.nativeResumeId) params.threadId = this.spec.nativeResumeId;
    const result = await this.rpc(
      this.spec.nativeResumeId ? "thread/resume" : "thread/start",
      params,
    );
    this.nativeModel = result.model ?? null;
    this.nativeSessionId = result.thread.id;
    invariant(
      !this.spec.nativeResumeId ||
        this.nativeSessionId === this.spec.nativeResumeId,
      "RESUME_FAILED",
      "Native resume returned another thread",
    );
    await this.emit({
      kind: "session.ready",
      nativeSessionId: this.nativeSessionId,
      capabilities: this.capabilities,
    });
  }
  private send(value: unknown) {
    invariant(!this.closed, "NATIVE_CLOSED", "Native process closed");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  rpc(method: string, params: any): Promise<any> {
    validateNativeRequest(method, params);
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new DomainError(
            "SUBMISSION_UNKNOWN",
            `Native request ${method} timed out`,
          ),
        );
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  private async message(m: any) {
    if (!m.method && typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        m.error
          ? p.reject(
              new DomainError(
                "NATIVE_ERROR",
                m.error.message ?? "Native error",
              ),
            )
          : p.resolve(m.result);
      }
      return;
    }
    const p = m.params ?? {};
    if (m.method && m.id !== undefined) {
      if (!this.current) {
        this.send({
          id: m.id,
          error: { code: -32000, message: "No active Atrium Grove run" },
        });
        return;
      }
      const supported = [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "mcpServer/elicitation/request",
        "item/tool/requestUserInput",
      ];
      if (!supported.includes(m.method)) {
        this.send({
          id: m.id,
          error: { code: -32601, message: "Unsupported approval form" },
        });
        return;
      }
      const approvalId = uuid(),
        hash = sha(canonical(p));
      this.approvals.set(approvalId, { id: m.id, method: m.method, hash });
      await this.emit({
        kind: "approval.requested",
        request: {
          approvalId,
          runId: this.current.runId,
          launchId: this.spec.launchId,
          nativeRequestId: String(m.id),
          source: "codex",
          kind: m.method.includes("UserInput")
            ? "question"
            : m.method.includes("elicitation")
              ? "form"
              : "permission",
          title: p.reason ?? p.message ?? m.method,
          inputSchema: p.requestedSchema ?? {},
          display: p,
          allowedActions: ["approve", "deny", "cancel"],
          argumentHash: hash,
        },
      });
      return;
    }
    switch (m.method) {
      case "turn/started":
        this.nativeTurn = p.turn.id;
        await this.emit({
          kind: "turn.started",
          nativeTurnId: this.nativeTurn,
        });
        break;
      case "item/agentMessage/delta":
        await this.emit({
          kind: "message.delta",
          messageId: p.itemId,
          blockIndex: 0,
          channel: "unknown",
          text: p.delta,
        });
        break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        await this.emit({
          kind: "tool.progress",
          callId: p.itemId,
          text: String(p.delta ?? "").slice(0, 32768),
        });
        break;
      case "item/mcpToolCall/progress":
        await this.emit({
          kind: "tool.progress",
          callId: p.itemId,
          text: String(p.message ?? "").slice(0, 32768),
        });
        break;
      case "item/started":
        if (!["agentMessage", "userMessage", "reasoning"].includes(p.item.type))
          await this.emit({
            kind: "tool.started",
            callId: p.item.id,
            name: p.item.type,
            input: codexToolInput(p.item),
          });
        break;
      case "item/completed":
        if (p.item.type === "agentMessage")
          await this.emit({
            kind: "message.completed",
            messageId: p.item.id,
            channel:
              p.item.phase === "final_answer"
                ? "final"
                : p.item.phase === "commentary"
                  ? "commentary"
                  : "unknown",
            text: p.item.text ?? "",
          });
        else if (!["userMessage", "reasoning"].includes(p.item.type))
          await this.emit({
            kind: "tool.completed",
            callId: p.item.id,
            outcome:
              p.item.status === "failed" ||
              p.item.error ||
              (p.item.exitCode != null && p.item.exitCode !== 0)
                ? "error"
                : p.item.status === "declined"
                  ? "cancelled"
                  : "ok",
            result: codexToolResult(p.item),
          });
        break;
      case "turn/completed": {
        const outcome =
          p.turn.status === "completed"
            ? "completed"
            : p.turn.status === "interrupted"
              ? "interrupted"
              : "failed";
        await this.emit({
          kind: "turn.terminal",
          outcome,
          ...(p.turn.error
            ? {
                error: {
                  code: "NATIVE_ERROR",
                  message: p.turn.error.message ?? "Native turn failed",
                  retryable: false,
                },
              }
            : {}),
        });
        this.current = null;
        this.nativeTurn = null;
        break;
      }
      case "thread/tokenUsage/updated": {
        const t = p.tokenUsage?.total;
        if (t)
          await this.emit({
            kind: "usage",
            measurementId: sha(canonical(p)),
            scope: "session",
            mode: "cumulative",
            inputTokens: t.inputTokens,
            outputTokens: t.outputTokens,
          });
        break;
      }
      default:
        if (m.method)
          await this.emit({
            kind: "native.unmapped",
            nativeType: m.method,
            rawLocalRef: nativeDiagnostic(this.spec.diagnosticDir, m),
          });
    }
  }
  async submit(input: RunInput) {
    if (this.current)
      return {
        status: "rejected" as const,
        inputId: input.inputId,
        error: {
          code: "INPUT_REJECTED_BUSY",
          message: "Active turn",
          retryable: false,
        },
      };
    this.current = input;
    try {
      const result = await this.rpc("turn/start", {
        threadId: this.nativeSessionId,
        input: [
          { type: "text", text: input.text, text_elements: [] },
          ...input.images.map((image) => {
            invariant(
              sha(readFileSync(image.localPath)) === image.sha256,
              "ARTIFACT_CORRUPT",
              "Input image hash changed",
            );
            return { type: "localImage", path: image.localPath };
          }),
        ],
        ...(this.spec.effort ? { effort: this.spec.effort } : {}),
      });
      this.nativeTurn = result.turn.id;
      await this.emit({
        kind: "input.receipt",
        inputId: input.inputId,
        evidence: "native_ack",
      });
      return {
        status: "accepted" as const,
        inputId: input.inputId,
        evidence: "native_ack" as const,
        nativeTurnId: result.turn.id,
      };
    } catch (error) {
      await this.emit({
        kind: "diagnostic",
        code: "SUBMISSION_UNKNOWN",
        message: String(error),
        severity: "error",
      });
      return {
        status: "unknown" as const,
        inputId: input.inputId,
        reason: String(error),
      };
    }
  }
  async steer(input: RunInput) {
    invariant(
      this.current && this.nativeTurn,
      "NO_ACTIVE_TURN",
      "No active native turn",
      409,
    );
    await this.rpc("turn/steer", {
      threadId: this.nativeSessionId,
      expectedTurnId: this.nativeTurn,
      input: [{ type: "text", text: input.text, text_elements: [] }],
    });
    return {
      status: "accepted" as const,
      inputId: input.inputId,
      evidence: "native_ack" as const,
    };
  }
  async interrupt() {
    if (this.current)
      await this.rpc("turn/interrupt", {
        threadId: this.nativeSessionId,
        turnId: this.nativeTurn,
      });
    return {
      requestAccepted: true,
      terminalConfirmed: !this.current,
      resourcesQuiescent: !this.current,
    };
  }
  async respond(d: HumanDecision) {
    const pending = this.approvals.get(d.approvalId);
    invariant(
      pending && pending.hash === d.argumentHash,
      "STALE_APPROVAL",
      "Approval no longer pending",
      409,
    );
    let result: any;
    if (pending.method.includes("UserInput"))
      result = d.action === "approve" ? d.content : { answers: {} };
    else if (pending.method.includes("elicitation"))
      result = {
        action:
          d.action === "approve"
            ? "accept"
            : d.action === "deny"
              ? "decline"
              : "cancel",
        content: d.content,
      };
    else
      result = {
        decision:
          d.action === "approve"
            ? d.scope === "session"
              ? "acceptForSession"
              : "accept"
            : d.action === "deny"
              ? "decline"
              : "cancel",
      };
    this.send({ id: pending.id, result });
    this.approvals.delete(d.approvalId);
    await this.emit({
      kind: "approval.resolved",
      approvalId: d.approvalId,
      outcome:
        d.action === "approve"
          ? "accepted"
          : d.action === "deny"
            ? "denied"
            : "cancelled",
    });
  }
  async reconcile() {
    return {
      nativeSessionExists: !!this.nativeSessionId,
      activeTurn: this.closed
        ? ("unknown" as const)
        : this.current
          ? ("running" as const)
          : ("not_running" as const),
      evidence: ["owned app-server process and observed protocol state"],
    };
  }
  async close() {
    if (this.closed)
      return {
        requestAccepted: true,
        terminalConfirmed: true,
        resourcesQuiescent: !processGroupAlive(this.child?.pid),
      };
    const exit = once(this.child, "exit");
    if (this.child.pid) {
      try {
        process.kill(-this.child.pid, "SIGTERM");
      } catch {}
    }
    await Promise.race([exit, new Promise((r) => setTimeout(r, 5000).unref())]);
    return {
      requestAccepted: true,
      terminalConfirmed: this.closed,
      resourcesQuiescent: this.closed && !processGroupAlive(this.child?.pid),
    };
  }
}
