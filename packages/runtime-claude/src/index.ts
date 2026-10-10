import { tracePreview } from "../../runtime-common/src/telemetry.js";
import { toolDecision, claudePermissions } from "./policy.js";
import {
  nativeDiagnostic,
  processGroupAlive,
} from "../../runtime-common/src/index.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  query,
  type Query,
  type SDKUserMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../../runtime-testkit/src/index.js";
import { uuid, sha, canonical } from "../../persistence/src/index.js";
import { invariant } from "../../domain/src/index.js";
import { readFileSync, realpathSync } from "node:fs";
import { relative, isAbsolute, resolve } from "node:path";
import type {
  SessionSpec,
  HarnessSession,
  RuntimeEvent,
  RunInput,
  HumanDecision,
  RuntimeCapabilities,
} from "../../../spec/contracts/runtime.js";
export class ClaudeSession implements HarnessSession {
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    resume: "native",
    interrupt: "native",
    steering: "unsupported",
    acknowledgements: "transport_only",
    permissions: "interactive",
    mcp: true,
    images: true,
    backgroundTaskTracking: "partial",
    nativeToolInventory: "unknown",
  };
  nativeSessionId: string | null = null;
  nativeModel: string | null = null;
  private process?: ChildProcess;
  get processId() {
    return this.process?.pid;
  }
  private consumption?: Promise<void>;
  private stream!: Query;
  private queue = new AsyncQueue<SDKUserMessage>();
  private seq = 0;
  private current: RunInput | null = null;
  private closed = false;
  private interruptedRunId: string | null = null;
  private messageIds = new Map<string, string>();
  private approvals = new Map<
    string,
    { hash: string; resolve: (d: HumanDecision) => void }
  >();
  constructor(
    readonly spec: SessionSpec,
    private onEvent: (e: RuntimeEvent) => Promise<void>,
  ) {}
  private emit(body: any, lane: string[] = []) {
    return this.onEvent({
      ...body,
      launchId: this.spec.launchId,
      producerSeq: ++this.seq,
      agentId: this.spec.agentId,
      sessionId: this.spec.sessionId,
      runId: this.current?.runId ?? null,
      lane,
      occurredAt: new Date().toISOString(),
    });
  }
  async initialize() {
    invariant(
      sha(readFileSync(realpathSync(this.spec.executable.realPath))) ===
        this.spec.executable.sha256,
      "NATIVE_SCHEMA_MISMATCH",
      "Claude binary changed",
    );
    const options: Options = {
      spawnClaudeCodeProcess: (options) => {
        const child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
          signal: options.signal,
          detached: true,
        });
        this.process = child;
        child.stderr.resume();
        return child;
      },
      pathToClaudeCodeExecutable: this.spec.executable.realPath,
      cwd: this.spec.workspacePath,
      ...(this.spec.model !== "default" ? { model: this.spec.model } : {}),
      ...(this.spec.nativeResumeId ? { resume: this.spec.nativeResumeId } : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: this.spec.standingInstructions,
      },
      ...claudePermissions(this.spec),
      settingSources:
        this.spec.settingsProfile === "project-reviewed" ? ["project"] : [],
      strictMcpConfig: true,
      mcpServers: Object.fromEntries(
        this.spec.mcpServers.map((s) => [
          s.name,
          {
            type: "stdio" as const,
            command: s.command,
            args: s.args,
            env: s.env,
          },
        ]),
      ),
      includePartialMessages: true,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PreToolUse") return {};
                const name = input.tool_name,
                  args = input.tool_input as Record<string, unknown>;
                const decision = toolDecision(this.spec, name, args);
                if (!decision) return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: decision,
                    permissionDecisionReason:
                      decision === "deny"
                        ? "Atrium Grove profile denies this tool/path"
                        : decision === "ask"
                          ? "Atrium Grove requires human approval"
                          : "Allowed by Atrium Grove profile",
                  },
                };
              },
            ],
          },
        ],
      },
      canUseTool: async (name, input, context) => {
        invariant(this.current, "STALE_LAUNCH", "No active run");
        const id = uuid(),
          hash = sha(canonical(input));
        const promise = new Promise<HumanDecision>((resolve) =>
          this.approvals.set(id, { hash, resolve }),
        );
        context.signal.addEventListener(
          "abort",
          () => {
            this.approvals.get(id)?.resolve({
              approvalId: id,
              expectedVersion: 1,
              argumentHash: hash,
              action: "cancel",
            });
          },
          { once: true },
        );
        await this.emit({
          kind: "approval.requested",
          request: {
            approvalId: id,
            runId: this.current.runId,
            launchId: this.spec.launchId,
            nativeRequestId: context.toolUseID ?? id,
            source: "claude",
            kind: name === "AskUserQuestion" ? "question" : "permission",
            title: name,
            inputSchema: {},
            display: input,
            allowedActions: ["approve", "deny", "cancel"],
            argumentHash: hash,
          },
        });
        const answer = await promise;
        this.approvals.delete(id);
        await this.emit({
          kind: "approval.resolved",
          approvalId: id,
          outcome:
            answer.action === "approve"
              ? "accepted"
              : answer.action === "deny"
                ? "denied"
                : "cancelled",
        });
        return answer.action === "approve"
          ? {
              behavior: "allow",
              updatedInput:
                name === "AskUserQuestion"
                  ? { ...input, answers: answer.content?.answers ?? {} }
                  : input,
            }
          : {
              behavior: "deny",
              message: "Human denied or cancelled this request",
            };
      },
    };
    this.stream = query({ prompt: this.queue, options });
    this.consumption = this.consume();
    await this.stream.initializationResult();
  }
  private async consume() {
    try {
      for await (const value of this.stream) {
        const m = value as any;
        const lane = m.parent_tool_use_id ? [m.parent_tool_use_id] : [];
        if (m.type === "system" && m.subtype === "init") {
          this.nativeModel = m.model ?? null;
          this.nativeSessionId = m.session_id;
          invariant(
            !this.spec.nativeResumeId ||
              this.nativeSessionId === this.spec.nativeResumeId,
            "RESUME_FAILED",
            "Native transcript not restored",
          );
          await this.emit({
            kind: "session.ready",
            nativeSessionId: this.nativeSessionId,
            capabilities: this.capabilities,
          });
        } else if (m.type === "stream_event") {
          const e = m.event,
            key = lane.join("/");
          if (e.type === "message_start")
            this.messageIds.set(key, e.message.id);
          if (e.type === "content_block_delta" && e.delta.type === "text_delta")
            await this.emit(
              {
                kind: "message.delta",
                messageId: this.messageIds.get(key) ?? m.uuid,
                blockIndex: e.index,
                channel: "unknown",
                text: e.delta.text,
              },
              lane,
            );
          if (
            e.type === "content_block_start" &&
            e.content_block.type === "tool_use"
          )
            await this.emit(
              {
                kind: "tool.started",
                callId: e.content_block.id,
                name: e.content_block.name,
                input: tracePreview(e.content_block.input ?? {}),
              },
              lane,
            );
        } else if (m.type === "assistant") {
          const text = (m.message.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("\n\n");
          if (text)
            await this.emit(
              {
                kind: "message.completed",
                messageId: m.message.id,
                channel: "unknown",
                text,
              },
              lane,
            );
          for (const block of m.message.content ?? []) {
            if (block.type === "tool_use")
              await this.emit(
                {
                  kind: "tool.started",
                  callId: block.id,
                  name: block.name,
                  input: tracePreview(block.input ?? {}),
                },
                lane,
              );
          }
        } else if (m.type === "user") {
          for (const block of Array.isArray(m.message?.content)
            ? m.message.content
            : [])
            if (block.type === "tool_result")
              await this.emit(
                {
                  kind: "tool.completed",
                  callId: block.tool_use_id,
                  outcome: block.is_error ? "error" : "ok",
                  result: tracePreview(block.content ?? ""),
                },
                lane,
              );
        } else if (m.type === "result" && !lane.length) {
          await this.emit({
            kind: "usage",
            measurementId: m.uuid ?? uuid(),
            scope: "turn",
            mode: "delta",
            inputTokens: m.usage?.input_tokens,
            outputTokens: m.usage?.output_tokens,
            reportedCostUsd: m.total_cost_usd,
          });
          await this.emit({
            kind: "turn.terminal",
            outcome: m.is_error
              ? this.interruptedRunId === this.current?.runId &&
                m.subtype === "error_during_execution"
                ? "interrupted"
                : "failed"
              : "completed",
            finalText: m.result,
            error: m.is_error
              ? {
                  code: "NATIVE_ERROR",
                  message:
                    m.result ||
                    (m.errors?.length
                      ? JSON.stringify(m.errors)
                      : `Claude 返回执行错误（${m.subtype}）`),
                  retryable: false,
                }
              : undefined,
          });
          this.current = null;
        } else
          await this.emit(
            {
              kind: "native.unmapped",
              nativeType: m.type + ":" + (m.subtype ?? ""),
              rawLocalRef: nativeDiagnostic(this.spec.diagnosticDir, m),
            },
            lane,
          );
      }
    } catch (error) {
      await this.emit({
        kind: "diagnostic",
        code: "NATIVE_ERROR",
        message: String(error),
        severity: "error",
      });
    } finally {
      this.closed = true;
      await this.emit({
        kind: "process.exited",
        code: null,
        signal: null,
        expected: !this.current,
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
          message: "Active Claude turn",
          retryable: false,
        },
      };
    this.current = input;
    this.queue.push({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: input.text },
          ...input.images.map((image) => {
            const bytes = readFileSync(image.localPath);
            invariant(
              sha(bytes) === image.sha256,
              "ARTIFACT_CORRUPT",
              "Input image hash changed",
            );
            return {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: image.mimeType,
                data: bytes.toString("base64"),
              },
            };
          }),
        ],
      },
      parent_tool_use_id: null,
      session_id: this.nativeSessionId ?? "",
      uuid: input.inputId as ReturnType<typeof uuid>,
    });
    await this.emit({ kind: "turn.started" });
    await this.emit({
      kind: "input.receipt",
      inputId: input.inputId,
      evidence: "transport_written",
    });
    return {
      status: "accepted" as const,
      inputId: input.inputId,
      evidence: "transport_written" as const,
    };
  }
  async steer(input: RunInput) {
    return {
      status: "rejected" as const,
      inputId: input.inputId,
      error: {
        code: "UNSUPPORTED_STEER",
        message: "Claude profile does not support steering",
        retryable: false,
      },
    };
  }
  async interrupt() {
    const runId = this.current?.runId ?? null;
    await this.stream.interrupt();
    this.interruptedRunId = runId;
    return {
      requestAccepted: true,
      terminalConfirmed: !this.current,
      resourcesQuiescent: false,
    };
  }
  async respond(d: HumanDecision) {
    const p = this.approvals.get(d.approvalId);
    invariant(
      p && p.hash === d.argumentHash,
      "STALE_APPROVAL",
      "Approval expired",
      409,
    );
    p.resolve(d);
  }
  async reconcile() {
    return {
      nativeSessionExists: !!this.nativeSessionId,
      activeTurn: this.closed
        ? ("unknown" as const)
        : this.current
          ? ("running" as const)
          : ("not_running" as const),
      evidence: ["SDK Query state"],
    };
  }
  async close() {
    this.queue.close();
    const exited =
      this.process &&
      this.process.exitCode === null &&
      this.process.signalCode === null
        ? once(this.process, "exit")
        : Promise.resolve();
    this.stream.close();
    await Promise.race([
      exited,
      new Promise((r) => setTimeout(r, 10000).unref()),
    ]);
    await Promise.race([
      this.consumption ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 1000).unref()),
    ]);
    const gone =
      !!this.process &&
      (this.process.exitCode !== null || this.process.signalCode !== null);
    return {
      requestAccepted: true,
      terminalConfirmed: gone,
      resourcesQuiescent: gone && !processGroupAlive(this.process?.pid),
    };
  }
}
