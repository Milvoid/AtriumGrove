import type {
  HarnessSession,
  SessionSpec,
  RunInput,
  RuntimeEvent,
  RuntimeCapabilities,
  HumanDecision,
} from "../../../spec/contracts/runtime.js";
import { randomUUID } from "node:crypto";
export const capabilities: RuntimeCapabilities = {
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
export class Barrier {
  private resolve!: () => void;
  readonly promise = new Promise<void>((r) => (this.resolve = r));
  release() {
    this.resolve();
  }
}
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  push(value: T) {
    if (this.closed) throw new Error("Queue closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length)
          return Promise.resolve({ value: this.values.shift()!, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}
export class FakeSession implements HarnessSession {
  readonly capabilities = capabilities;
  readonly nativeSessionId: string;
  private seq = 0;
  private active: RunInput | null = null;
  private cancelled = false;
  constructor(
    readonly spec: SessionSpec,
    private onEvent: (e: RuntimeEvent) => Promise<void>,
    private tool?: (name: string, args: any) => Promise<any>,
  ) {
    this.nativeSessionId = spec.nativeResumeId ?? "fake-" + randomUUID();
  }
  async emit(body: any) {
    await this.onEvent({
      ...body,
      launchId: this.spec.launchId,
      producerSeq: ++this.seq,
      agentId: this.spec.agentId,
      sessionId: this.spec.sessionId,
      runId: this.active?.runId ?? null,
      lane: [],
      occurredAt: new Date().toISOString(),
    });
  }
  async initialize() {
    await this.emit({
      kind: "session.ready",
      nativeSessionId: this.nativeSessionId,
      capabilities,
    });
  }
  async submit(input: RunInput) {
    if (this.active)
      return {
        status: "rejected" as const,
        inputId: input.inputId,
        error: {
          code: "INPUT_REJECTED_BUSY",
          message: "Busy",
          retryable: false,
        },
      };
    this.active = input;
    this.cancelled = false;
    await this.emit({
      kind: "input.receipt",
      inputId: input.inputId,
      evidence: "transport_written",
    });
    void this.perform(input);
    return {
      status: "accepted" as const,
      inputId: input.inputId,
      evidence: "transport_written" as const,
    };
  }
  private async perform(input: RunInput) {
    try {
      await this.emit({
        kind: "turn.started",
        nativeTurnId: "fake-turn-" + input.runId,
      });
      await this.emit({
        kind: "tool.started",
        callId: input.inputId,
        name: "collab_context",
        input: {},
      });
      if (this.tool) await this.tool("collab_context", {});
      await this.emit({
        kind: "tool.completed",
        callId: input.inputId,
        outcome: "ok",
        result: { testRuntime: true },
      });
      const text = `[FAKE RUNTIME] ${this.spec.agentId}: received ${input.primaryMessageId}. Deterministic transport demonstration; no model ran.`;
      await this.emit({
        kind: "message.delta",
        messageId: input.inputId,
        blockIndex: 0,
        channel: "final",
        text,
      });
      await this.emit({
        kind: "turn.terminal",
        outcome: this.cancelled ? "interrupted" : "completed",
        finalText: text,
      });
    } finally {
      this.active = null;
    }
  }
  async steer(input: RunInput) {
    return {
      status: "rejected" as const,
      inputId: input.inputId,
      error: {
        code: "UNSUPPORTED_STEER",
        message: "Fake script does not steer",
        retryable: false,
      },
    };
  }
  async interrupt() {
    this.cancelled = true;
    return {
      requestAccepted: true,
      terminalConfirmed: !this.active,
      resourcesQuiescent: !this.active,
    };
  }
  async respond(_d: HumanDecision) {}
  async reconcile() {
    return {
      nativeSessionExists: true,
      activeTurn: this.active ? ("running" as const) : ("not_running" as const),
      evidence: ["fake runtime state"],
    };
  }
  async close() {
    return this.interrupt();
  }
}
