export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function invariant(
  condition: unknown,
  code: string,
  message: string,
  status = 422,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
export const ACTIVE_RUNS = [
  "scheduled",
  "dispatching",
  "running",
  "waiting_approval",
  "draining",
  "unknown",
];
export const TERMINAL_RUNS = ["completed", "failed", "interrupted"];
export function canTransitionTask(
  from: string,
  to: string,
  owner: string | null,
  reviewer: string | null,
  actor: string,
  human: boolean,
  evidence: number,
) {
  const allowed: Record<string, string[]> = {
    todo: ["cancelled"],
    in_progress: ["blocked", "in_review", "cancelled"],
    blocked: ["todo", "cancelled"],
    in_review: ["blocked", "done", "cancelled"],
    done: [],
    cancelled: [],
  };
  invariant(
    allowed[from]?.includes(to),
    "INVALID_TRANSITION",
    `Cannot transition ${from} to ${to}`,
  );
  if (to === "done")
    invariant(
      (human || (actor === reviewer && actor !== owner)) && evidence > 0,
      "REVIEW_REQUIRED",
      "Independent reviewer and evidence required",
      403,
    );
  else
    invariant(
      human || actor === owner,
      "TASK_OWNED",
      "Only the task owner may transition this task",
      403,
    );
  if (to === "todo" || to === "cancelled")
    invariant(human, "OWNER_REQUIRED", "Human control required", 403);
  if (to === "in_review")
    invariant(
      evidence > 0,
      "EVIDENCE_REQUIRED",
      "Attach evidence before requesting review",
    );
}
export function assertMessageLimits(
  blocks: Array<{ type: string; text?: string }>,
) {
  let size = 0,
    attachments = 0;
  for (const block of blocks) {
    if (block.type === "text") {
      const bytes = new TextEncoder().encode(block.text ?? "").length;
      invariant(
        bytes <= 65536,
        "MESSAGE_TOO_LARGE",
        "Text block exceeds 64 KiB",
      );
      size += bytes;
    } else attachments++;
  }
  invariant(
    size <= 131072 && attachments <= 16,
    "MESSAGE_TOO_LARGE",
    "Message exceeds 128 KiB or 16 attachments",
  );
}
export function hasCycle(
  edges: Array<[string, string]>,
  task: string,
  dependency: string,
): boolean {
  const seen = new Set<string>();
  const pending = [dependency];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === task) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const [a, b] of edges) if (a === id) pending.push(b);
  }
  return false;
}
export class UsageCounter {
  private seen = new Set<string>();
  private cumulative = new Map<string, number>();
  inputTokens: number | null = null;
  outputTokens: number | null = null;
  apply(e: {
    measurementId: string;
    scope: string;
    mode: string;
    inputTokens?: number;
    outputTokens?: number;
  }) {
    if (this.seen.has(e.measurementId)) return;
    this.seen.add(e.measurementId);
    for (const key of ["inputTokens", "outputTokens"] as const) {
      const value = e[key];
      if (value === undefined || e.mode === "unknown") continue;
      const id = `${e.scope}:${key}`;
      const previous = this.cumulative.get(id) ?? 0;
      const delta =
        e.mode === "cumulative"
          ? value >= previous
            ? value - previous
            : value
          : value;
      if (e.mode === "cumulative") this.cumulative.set(id, value);
      this[key] = (this[key] ?? 0) + Math.max(0, delta);
    }
  }
}
