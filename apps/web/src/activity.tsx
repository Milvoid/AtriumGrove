import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  mergeTrace,
  projectTrace,
  toolTitle,
  type TraceRecord,
  type Activity,
} from "./activity-model.js";
const terminalStates = new Set(["completed", "failed", "interrupted"]);
const states: Record<string, string> = {
  scheduled: "等待执行",
  dispatching: "正在准备",
  running: "正在执行",
  waiting_approval: "等待批准",
  draining: "正在结束本轮",
  unknown: "执行状态待确认",
  failed: "执行失败",
  interrupted: "已中断",
  completed: "已完成",
};
const show = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
function Tool({ item, finished }: { item: Activity; finished: boolean }) {
  const result = item.result as Record<string, any> | undefined;
  const observations = Array.isArray(result?.observations)
    ? result.observations
    : [];
  return (
    <details className="tool-activity">
      <summary>
        <span aria-hidden="true">
          {item.outcome === "error"
            ? "!"
            : item.outcome
              ? "✓"
              : finished
                ? "−"
                : "◌"}
        </span>
        <span className="tool-title">{toolTitle(item)}</span>
        {item.lane.length > 0 && <small>子任务</small>}
        <small>
          {item.outcome === "error"
            ? "失败"
            : item.outcome === "cancelled"
              ? "已取消"
              : !item.outcome
                ? finished
                  ? "未返回结果"
                  : "进行中"
                : ""}
        </small>
      </summary>
      <div className="tool-detail">
        {observations.map((o: any, index: number) => (
          <figure className="computer-observation" key={index}>
            {typeof o.artifactId === "string" &&
            /^[0-9a-f-]{36}$/i.test(o.artifactId) ? (
              <a
                href={`/v1/artifacts/${o.artifactId}/content`}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  loading="lazy"
                  src={`/v1/artifacts/${o.artifactId}/content`}
                  alt="电脑操作截图"
                />
              </a>
            ) : (
              <p className="error">截图留存失败；原始截图已返回成员。</p>
            )}
            <figcaption>
              历史截图 · {new Date(o.capturedAt).toLocaleTimeString()}
            </figcaption>
          </figure>
        ))}
        {item.input && Object.keys(item.input).length > 0 && (
          <pre>{show(item.input)}</pre>
        )}
        {item.result !== undefined ? (
          <pre>{show(item.result)}</pre>
        ) : item.text ? (
          <pre>{item.text}</pre>
        ) : (
          <p>等待工具返回结果</p>
        )}
      </div>
    </details>
  );
}
export function RunActivity({
  run,
  api,
  finalText,
  onUpdate,
  onInspect,
}: {
  run: Record<string, any>;
  api: (path: string) => Promise<any>;
  finalText?: string;
  onUpdate: () => void;
  onInspect: () => void;
}) {
  const qc = useQueryClient();
  const trace = useQuery<TraceRecord[]>({
    refetchInterval: terminalStates.has(run.state) ? false : 1500,
    queryKey: ["chat-trace", run.id],
    queryFn: async () => {
      let records: TraceRecord[] = [],
        cursor: string | null = null;
      do {
        const page: any = await api(
          `/runs/${run.id}/events?limit=200${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
        );
        records.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return mergeTrace(
        qc.getQueryData<TraceRecord[]>(["chat-trace", run.id]),
        records,
      );
    },
    staleTime: 0,
  });
  // Refetch on terminal state as a backstop for completion racing the SSE connection.
  useEffect(() => {
    void trace.refetch();
  }, [run.state]);
  const { items, terminal } = projectTrace(trace.data ?? []);
  const finished = terminalStates.has(run.state) || !!terminal;
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (finished) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [finished]);
  useEffect(onUpdate, [trace.data, run.state]);
  const elapsed = run.startedAt
    ? Math.max(
        0,
        Math.floor(
          ((finished && run.endedAt ? Date.parse(run.endedAt) : clock) -
            Date.parse(run.startedAt)) /
            1000,
        ),
      )
    : 0;
  const hasComputerTrace = items.some((item) => item.name === "computer");
  const visible = items.filter(
    (item) =>
      !(
        hasComputerTrace &&
        (item.name?.startsWith("mcp__harbor_computer__") ||
          item.input?.server === "harbor_computer")
      ) &&
      !(
        item.type === "text" &&
        !item.lane.length &&
        finalText !== undefined &&
        (item.text.trim() === finalText.trim() || item.channel === "final")
      ),
  );
  const groups: (Activity | Activity[])[] = [];
  for (const item of visible) {
    const last = groups.at(-1);
    if (item.type === "tool") {
      if (Array.isArray(last)) last.push(item);
      else groups.push([item]);
    } else groups.push(item);
  }
  return (
    <div className="run-activity" aria-label="执行过程">
      {trace.isPending && (
        <p className="activity-status" role="status">
          正在读取执行过程…
        </p>
      )}
      {trace.isError && (
        <button className="activity-error" onClick={() => void trace.refetch()}>
          执行过程读取失败，点击重试
        </button>
      )}
      {groups.map((group) =>
        Array.isArray(group) ? (
          <details className="tool-group" key={group[0]!.id} open>
            <summary>
              {group.length} 项工具操作{" "}
              <span>
                {group.some((i) => i.outcome === "error")
                  ? "· 有失败"
                  : group.some((i) => !i.outcome) && !finished
                    ? "· 进行中"
                    : ""}
              </span>
            </summary>
            {group.map((item) => (
              <Tool key={item.id} item={item} finished={finished} />
            ))}
          </details>
        ) : (
          <div className="message-text activity-text" key={group.id}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                img: ({ alt }) => <span>[图片：{alt}]</span>,
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {group.text}
            </ReactMarkdown>
          </div>
        ),
      )}
      {finalText === undefined &&
        terminal?.finalText &&
        !items.some(
          (i) =>
            i.type === "text" && i.text.trim() === terminal.finalText.trim(),
        ) && (
          <div className="message-text">
            <ReactMarkdown skipHtml>{terminal.finalText}</ReactMarkdown>
          </div>
        )}
      {terminal?.error?.message && (
        <p className="error">
          {terminal.error.message === '"success"'
            ? "本次执行失败，原因见上方模型返回信息。"
            : terminal.error.message}
        </p>
      )}
      {(!finished || run.state !== "completed") && (
        <div className="activity-status" role="status">
          <span className={!finished ? "activity-pulse" : ""} />
          <span>
            {run.state === "running" && !items.length
              ? "等待模型输出…"
              : (states[run.state] ?? run.state)}
          </span>
          {elapsed > 0 && (
            <time>
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </time>
          )}
          <button onClick={onInspect}>
            {run.state === "waiting_approval" ? "查看审批" : "查看执行"}
          </button>
        </div>
      )}
    </div>
  );
}
