export type TraceRecord = {
  id: string;
  launchId: string;
  producerSeq: number;
  runId: string;
  lane: string[];
  occurredAt: string;
  kind: string;
  payload: Record<string, any>;
};
export function mergeTrace(
  current: TraceRecord[] = [],
  incoming: TraceRecord[] = [],
) {
  const records = new Map(
    current.map((r) => [r.launchId + ":" + r.producerSeq, r]),
  );
  for (const r of incoming) records.set(r.launchId + ":" + r.producerSeq, r);
  return [...records.values()].sort((a, b) =>
    a.launchId === b.launchId
      ? a.producerSeq - b.producerSeq
      : a.occurredAt.localeCompare(b.occurredAt),
  );
}
export type Activity = {
  id: string;
  type: "text" | "tool";
  text: string;
  lane: string[];
  name?: string;
  input?: Record<string, any>;
  result?: unknown;
  outcome?: string;
  channel?: string;
  blocks?: Record<number, string>;
};
export function projectTrace(records: TraceRecord[]) {
  const items = new Map<string, Activity>();
  let terminal: Record<string, any> | undefined;
  for (const r of records) {
    const p = r.payload,
      lane = r.lane ?? [];
    const id = JSON.stringify([lane, p.messageId ?? p.callId]);
    if (r.kind === "message.delta" || r.kind === "message.completed") {
      const item =
        items.get(id) ??
        ({
          id,
          type: "text",
          text: "",
          blocks: {},
          lane,
          channel: p.channel,
        } as Activity);
      if (r.kind === "message.completed") {
        item.text = p.text;
        item.channel = p.channel;
      } else {
        item.blocks![p.blockIndex] =
          (item.blocks![p.blockIndex] ?? "") + p.text;
        item.text = Object.keys(item.blocks!)
          .map(Number)
          .sort((a, b) => a - b)
          .map((k) => item.blocks![k])
          .join("\n\n");
      }
      items.set(id, item);
    } else if (r.kind.startsWith("tool.")) {
      const item =
        items.get(id) ?? ({ id, type: "tool", text: "", lane } as Activity);
      if (r.kind === "tool.started") {
        item.name = p.name;
        item.input = p.input;
      }
      if (r.kind === "tool.progress")
        item.text = (item.text + p.text).slice(-65536);
      if (r.kind === "tool.completed") {
        item.outcome = p.outcome;
        item.result = p.result;
      }
      items.set(id, item);
    } else if (r.kind === "turn.terminal" && !lane.length) terminal = p;
  }
  return { items: [...items.values()], terminal };
}
const names: Record<string, string> = {
  computer: "电脑操作",
  commandExecution: "运行命令",
  Bash: "运行命令",
  Read: "读取文件",
  Write: "写入文件",
  Edit: "编辑文件",
  MultiEdit: "编辑文件",
  Glob: "查找文件",
  Grep: "搜索内容",
  fileChange: "修改文件",
  webSearch: "搜索网页",
  WebSearch: "搜索网页",
  WebFetch: "读取网页",
  mcpToolCall: "调用工具",
  dynamicToolCall: "调用工具",
  collab_context: "读取协作上下文",
  Agent: "委派任务",
  Task: "委派任务",
};
export function toolTitle(item: Activity) {
  const p = item.input ?? {},
    detail =
      p.title ??
      p.command ??
      p.file_path ??
      p.path ??
      p.pattern ??
      p.query ??
      p.url ??
      p.description ??
      p.tool ??
      p.changes?.map((c: any) => c.path).join(", ");
  return [
    names[item.name ?? ""] ?? item.name ?? "工具",
    typeof detail === "string" ? detail : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function pendingActivityLabel(item: Record<string, any>) {
  if (item.hostState !== "online") return "执行服务离线，消息尚未开始处理";
  if (["unknown", "degraded", "failed"].includes(item.agentState))
    return "会话连接异常，消息尚未开始处理";
  if (item.episodeState === "paused_budget")
    return "本轮达到执行上限，后续回复已暂停";
  if (item.episodeState !== "open") return "本轮已暂停，消息尚未开始处理";
  if (item.busy) return "等待该成员完成上一项任务";
  if (["starting", "recovering"].includes(item.agentState))
    return "正在连接模型…";
  return "等待成员开始处理…";
}
