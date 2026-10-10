/** Atrium Grove 1.0 internal contracts. Original specification code, not copied upstream.
 * No vendor objects leak into the control-plane domain. Native payloads are opaque.
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };
export type Id = string; // UUID at wire validation boundaries.
export type NativeId = string; // Never parse a native ID as a Atrium Grove UUID.
export type DriverId = 'codex-app-server' | 'claude-code-sdk';
export type Evidence = 'transport_written' | 'native_ack' | 'context_included' | 'agent_ack';
export type NativeOutcome = 'completed' | 'failed' | 'interrupted';
export type RunState = 'scheduled' | 'dispatching' | 'running' | 'waiting_approval'
  | 'draining' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export interface RuntimeCapabilities {
  streaming: boolean;
  resume: 'native' | 'unsupported';
  interrupt: 'native' | 'process_only' | 'unsupported';
  steering: 'native' | 'next_turn_only' | 'unsupported';
  acknowledgements: 'native_echo' | 'request_receipt' | 'transport_only';
  permissions: 'interactive' | 'none';
  mcp: boolean;
  images: boolean;
  backgroundTaskTracking: 'complete_for_reported_tasks' | 'partial' | 'none';
  nativeToolInventory: 'available' | 'unknown';
}
export interface ExecutableProfile {
  id: string;
  realPath: string;
  sha256: string;
  version: string;
  authProfileRef: string; // Local profile reference, never a token.
  qualifiedAt?: string;
}
export interface McpLaunchSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>; // Must be redacted when recorded.
}
export interface SessionSpec {
  agentId: Id;
  sessionId: Id;
  launchId: Id;
  generation: number;
  driver: DriverId;
  executable: ExecutableProfile;
  workspacePath: string;
  model: string;
  effort?: string;
  permissionProfile: 'review' | 'workspace' | 'desktop' | 'read-only' | 'ask-for-approval' | 'auto-approve' | 'full-access';
  settingsProfile: string;
  standingInstructions: string;
  diagnosticDir?: string;
  mcpServers: McpLaunchSpec[];
  nativeResumeId?: NativeId;
}
export interface InputImage { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; localPath: string; sha256: string; }
export interface RunInput {
  runId: Id;
  inputId: Id;
  episodeId: Id;
  primaryMessageId: Id;
  deliveryIds: Id[];
  text: string;
  images: InputImage[];
  contextDigest: string;
  source: 'human_dispatch' | 'agent_message' | 'task_dispatch' | 'requested_reply';
}
export interface EventIdentity {
  launchId: Id;
  producerSeq: number; // Restarted only for a NEW launchId.
  agentId: Id;
  sessionId: Id;
  runId: Id | null;
  nativeThreadId?: NativeId;
  nativeTurnId?: NativeId;
  lane: string[]; // [] = root. Native children never become peers implicitly.
  occurredAt: string;
}
export type EventBody =
  | { kind: 'session.ready'; nativeSessionId: NativeId; capabilities: RuntimeCapabilities }
  | { kind: 'input.receipt'; inputId: Id; evidence: Evidence; nativeRef?: string }
  | { kind: 'turn.started'; nativeTurnId?: NativeId }
  | { kind: 'message.delta'; messageId: string; blockIndex: number; channel: 'commentary' | 'final' | 'unknown'; text: string }
  | { kind: 'message.completed'; messageId: string; channel: 'commentary' | 'final' | 'unknown'; text: string }
  | { kind: 'tool.started'; callId: string; name: string; input: JsonObject }
  | { kind: 'tool.progress'; callId: string; text: string }
  | { kind: 'tool.completed'; callId: string; outcome: 'ok' | 'error' | 'cancelled'; result: Json }
  | { kind: 'approval.requested'; request: ApprovalRequest }
  | { kind: 'approval.resolved'; approvalId: Id; outcome: 'accepted' | 'denied' | 'cancelled' }
  | { kind: 'background.updated'; taskId: string; state: 'running' | 'completed' | 'failed' | 'unknown'; ownsResources: string[] }
  | { kind: 'compaction'; phase: 'started' | 'completed' | 'failed' }
  | { kind: 'usage'; measurementId: string; scope: 'turn' | 'session' | 'unknown'; mode: 'delta' | 'cumulative' | 'unknown'; inputTokens?: number; outputTokens?: number; cacheTokens?: number; reportedCostUsd?: number }
  | { kind: 'turn.terminal'; outcome: NativeOutcome; finalText?: string; error?: PlatformError }
  | { kind: 'resources.quiescent' }
  | { kind: 'diagnostic'; code: string; message: string; severity: 'info' | 'warning' | 'error' }
  | { kind: 'process.exited'; code: number | null; signal: string | null; expected: boolean }
  | { kind: 'native.unmapped'; nativeType: string; rawLocalRef: string };
export type RuntimeEvent = EventIdentity & EventBody;
export interface PlatformError { code: string; message: string; retryable: boolean; details?: JsonObject; }
export interface ApprovalRequest {
  approvalId: Id;
  runId: Id;
  launchId: Id;
  nativeRequestId: string;
  source: 'codex' | 'claude' | 'computer-use';
  kind: 'permission' | 'question' | 'form' | 'url';
  title: string;
  inputSchema: JsonObject;
  display: JsonObject;
  allowedActions: string[];
  argumentHash: string;
}
export interface HumanDecision {
  argumentHash: string;
  approvalId: Id;
  expectedVersion: number;
  action: 'approve' | 'deny' | 'cancel';
  content?: JsonObject;
  scope?: 'once' | 'session';
}
export type SubmitReceipt =
  | { status: 'accepted'; inputId: Id; evidence: 'transport_written' | 'native_ack'; nativeTurnId?: string }
  | { status: 'rejected'; inputId: Id; error: PlatformError }
  | { status: 'unknown'; inputId: Id; reason: string };
export interface CancellationReceipt { requestAccepted: boolean; terminalConfirmed: boolean; resourcesQuiescent: boolean; }
export interface Reconciliation {
  nativeSessionExists: boolean | null;
  activeTurn: 'running' | 'not_running' | 'unknown';
  nativeTurnId?: string;
  terminalOutcome?: NativeOutcome;
  evidence: string[];
}
export interface HarnessSession {
  readonly spec: SessionSpec;
  readonly capabilities: RuntimeCapabilities;
  readonly nativeSessionId: NativeId | null;
  /** Host establishes run correlation and persists command before calling. */
  submit(input: RunInput, signal: AbortSignal): Promise<SubmitReceipt>;
  /** Explicit human steering only in v1. Never feed every room update here. */
  steer(input: RunInput, signal: AbortSignal): Promise<SubmitReceipt>;
  interrupt(runId: Id, signal: AbortSignal): Promise<CancellationReceipt>;
  respond(decision: HumanDecision, signal: AbortSignal): Promise<void>;
  reconcile(signal: AbortSignal): Promise<Reconciliation>;
  close(reason: 'idle_recycle' | 'shutdown' | 'reset', signal: AbortSignal): Promise<CancellationReceipt>;
}
export interface HarnessDriver {
  readonly id: DriverId;
  probe(profile: ExecutableProfile, signal: AbortSignal): Promise<RuntimeCapabilities>;
  /** onEvent is connected BEFORE any native process initialization. */
  open(spec: SessionSpec, onEvent: (event: RuntimeEvent) => Promise<void>, signal: AbortSignal): Promise<HarnessSession>;
}
export interface CommandEnvelope {
  schemaVersion: 1;
  commandId: Id;
  controllerEpoch: Id;
  hostId: Id;
  issuedAt: string;
  expiresAt: string;
  kind: 'runtime.open' | 'runtime.reconcile' | 'runtime.submit' | 'runtime.steer' | 'runtime.interrupt' | 'runtime.close'
    | 'approval.respond' | 'host.probe' | 'desktop.stop' | 'desktop.clear_quarantine' | 'artifact.export' | 'project.verify' | 'worktree.ensure';
  launchId?: Id;
  runId?: Id;
  payload: JsonObject;
  payloadHash: string;
}
export interface HostHello {
  schemaVersion: 1;
  hostId: Id;
  bootId: Id;
  protocolVersion: 'harbor-host.v1';
  launches: { launchId: Id; sessionId: Id; runId: Id | null; nativeSessionId: string | null; state: string }[];
  spoolCursors: { launchId: Id; lastProducedSeq: number; lastAckedSeq: number }[];
}
export interface CommandReceipt {
  commandId: Id;
  payloadHash: string;
  state: 'received' | 'issuing' | 'accepted' | 'completed' | 'failed' | 'unknown';
  launchId?: Id;
  error?: PlatformError;
}
export interface ToolDescriptor { name: string; description?: string; inputSchema: JsonObject; annotations?: JsonObject; }
/** Preserve all content fields, including image/resource/audio/error metadata. */
export interface McpResult { content: JsonObject[]; structuredContent?: Json; isError?: boolean; }
export interface DesktopContext {
  workspaceId: Id;
  agentId: Id;
  launchId: Id;
  runId: Id;
  hostSessionId: string;
  hostTurnId: string;
  nativeTurnId?: string;
  resourceId: string;
  leaseEpoch: number;
}
export interface DesktopQualification {
  available: boolean;
  providerVersion: string;
  runtimeFingerprint: string;
  instructionsSha256: string;
  toolSchemaSha256: string;
  interactiveApprovals: boolean;
  cleanup: 'confirmed' | 'unverified';
  diagnostics: string[];
}
export interface DesktopConnection {
  readonly instructions: string;
  readonly publicTools: ToolDescriptor[];
  invoke(name: string, args: JsonObject, context: DesktopContext, signal: AbortSignal): Promise<McpResult>;
  /** Host-only operation after actual terminal events, not exposed to a model. */
  endTurn(context: DesktopContext, reason: 'Stop' | 'Interrupted' | 'Shutdown', signal: AbortSignal): Promise<{ quiescent: boolean; receipt: Json }>;
  close(signal: AbortSignal): Promise<void>;
}
export interface ComputerUseProvider {
  readonly id: 'lcu' | 'direct-mcp' | 'mock';
  probe(signal: AbortSignal): Promise<DesktopQualification>;
  open(onElicitation: (request: ApprovalRequest) => Promise<HumanDecision>, context: DesktopContext, signal: AbortSignal): Promise<DesktopConnection>;
}
export interface BoundToolCaller {
  workspaceId: Id;
  agentId: Id;
  sessionId: Id;
  launchId: Id;
  runId: Id;
  capabilities: readonly string[];
  channelIds: readonly Id[];
}
export interface CollaborationToolServer {
  list(caller: BoundToolCaller): Promise<ToolDescriptor[]>;
  call(caller: BoundToolCaller, name: string, args: JsonObject, signal: AbortSignal): Promise<McpResult>;
}
export interface DurableEvent {
  schemaVersion: 1;
  eventId: Id;
  seq: string;
  workspaceId: Id;
  type: string;
  occurredAt: string;
  actor: { kind: 'human' | 'agent' | 'system'; id: Id; displayName: string };
  entityId?: Id | null;
  payload: JsonObject;
}
