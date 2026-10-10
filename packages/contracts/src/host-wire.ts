/** Versioned Host boundaries. Native vendor payloads remain opaque. */
const id = { type: "string", format: "uuid" };
const seq = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const string = { type: "string" };
const object = { type: "object" };
const nullableId = { anyOf: [id, { type: "null" }] };
const array = (items: unknown, maxItems = 100) => ({
  type: "array",
  items,
  maxItems,
});
const record = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const eventBodies: Record<string, Record<string, unknown>> = {
  "session.ready": { nativeSessionId: string, capabilities: object },
  "input.receipt": {
    inputId: id,
    evidence: {
      enum: [
        "transport_written",
        "native_ack",
        "context_included",
        "agent_ack",
      ],
    },
  },
  "turn.started": {},
  "message.delta": {
    messageId: string,
    blockIndex: seq,
    channel: { enum: ["commentary", "final", "unknown"] },
    text: string,
  },
  "message.completed": {
    messageId: string,
    channel: { enum: ["commentary", "final", "unknown"] },
    text: string,
  },
  "tool.started": { callId: string, name: string, input: object },
  "tool.progress": { callId: string, text: string },
  "tool.completed": {
    callId: string,
    outcome: { enum: ["ok", "error", "cancelled"] },
    result: {},
  },
  "approval.requested": {
    request: record({
      approvalId: id,
      runId: id,
      launchId: id,
      nativeRequestId: string,
      source: { enum: ["codex", "claude", "computer-use"] },
      kind: { enum: ["permission", "question", "form", "url"] },
      title: string,
      inputSchema: object,
      display: object,
      allowedActions: array({ enum: ["approve", "deny", "cancel"] }, 3),
      argumentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }),
  },
  "approval.resolved": {
    approvalId: id,
    outcome: { enum: ["accepted", "denied", "cancelled"] },
  },
  "background.updated": {
    taskId: string,
    state: { enum: ["running", "completed", "failed", "unknown"] },
    ownsResources: array(string),
  },
  compaction: { phase: { enum: ["started", "completed", "failed"] } },
  usage: {
    measurementId: string,
    scope: { enum: ["turn", "session", "unknown"] },
    mode: { enum: ["delta", "cumulative", "unknown"] },
  },
  "turn.terminal": {
    outcome: { enum: ["completed", "failed", "interrupted"] },
  },
  "resources.quiescent": {},
  diagnostic: {
    code: string,
    message: string,
    severity: { enum: ["info", "warning", "error"] },
  },
  "process.exited": {
    code: { type: ["integer", "null"] },
    signal: { type: ["string", "null"] },
    expected: { type: "boolean" },
  },
  "native.unmapped": { nativeType: string, rawLocalRef: string },
};
const identity = {
  launchId: id,
  producerSeq: { ...seq, minimum: 1 },
  agentId: id,
  sessionId: id,
  runId: nullableId,
  lane: array(string),
  occurredAt: { type: "string", format: "date-time" },
};
export const runtimeEventSchema = {
  oneOf: Object.entries(eventBodies).map(([kind, fields]) => ({
    type: "object",
    properties: { ...identity, kind: { const: kind }, ...fields },
    required: [...Object.keys(identity), "kind", ...Object.keys(fields)],
    // Optional normalized fields include native IDs, usage totals and terminal error.
    additionalProperties: true,
  })),
};
const command = record(
  {
    schemaVersion: { const: 1 },
    commandId: id,
    controllerEpoch: id,
    hostId: id,
    issuedAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    kind: {
      enum: [
        "runtime.open",
        "runtime.reconcile",
        "runtime.submit",
        "runtime.steer",
        "runtime.interrupt",
        "runtime.close",
        "approval.respond",
        "host.probe",
        "desktop.stop",
        "desktop.clear_quarantine",
        "artifact.export",
        "project.verify",
        "project.git.initialize",
        "worktree.ensure",
      ],
    },
    launchId: id,
    runId: id,
    payload: object,
    payloadHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  [
    "schemaVersion",
    "commandId",
    "controllerEpoch",
    "hostId",
    "issuedAt",
    "expiresAt",
    "kind",
    "payload",
    "payloadHash",
  ],
);
const frames: Record<string, Record<string, unknown>> = {
  hello: {
    hostId: id,
    bootId: id,
    protocolVersion: { const: "harbor-host.v1" },
    launches: array(
      record({
        launchId: id,
        sessionId: id,
        runId: nullableId,
        nativeSessionId: { type: ["string", "null"] },
        state: string,
      }),
      1000,
    ),
    spoolCursors: array(
      record({ launchId: id, lastProducedSeq: seq, lastAckedSeq: seq }),
      1000,
    ),
  },
  welcome: {
    protocolVersion: { const: "harbor-host.v1" },
    controllerEpoch: id,
    heartbeatMs: seq,
    maxBatchEvents: seq,
    maxFrameBytes: seq,
  },
  command: { command },
  command_receipt: {
    receipt: {
      type: "object",
      properties: {
        commandId: id,
        payloadHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        state: {
          enum: [
            "received",
            "issuing",
            "accepted",
            "completed",
            "failed",
            "unknown",
          ],
        },
        result: {},
        error: object,
      },
      required: ["commandId", "payloadHash", "state"],
    },
  },
  events_batch: { events: array(runtimeEventSchema) },
  events_ack: { cursors: array(record({ launchId: id, producerSeq: seq })) },
  rpc: {
    id,
    caller: record({
      workspaceId: id,
      agentId: id,
      sessionId: id,
      launchId: id,
      runId: id,
      capabilities: array(string),
      channelIds: array(id),
    }),
    name: string,
    args: object,
  },
  rpc_result: { id, result: {}, error: object },
  inventory: { entries: array(object) },
  resource_snapshot: { resource: object },
  ping: {},
  pong: {},
  gap: {},
  host_diagnostic: { message: string },
};
export const hostFrameSchema = {
  oneOf: Object.entries(frames).map(([type, properties]) =>
    record(
      { schemaVersion: { const: 1 }, type: { const: type }, ...properties },
      [
        "schemaVersion",
        "type",
        ...Object.keys(properties).filter(
          (k) => type !== "rpc_result" || k === "id",
        ),
      ],
    ),
  ),
};
