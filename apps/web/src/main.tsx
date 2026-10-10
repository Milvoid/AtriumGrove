import { RunActivity } from "./activity.js";
import {
  mergeTrace,
  pendingActivityLabel,
  type TraceRecord,
} from "./activity-model.js";
import { CapabilityField, ComputerUseField } from "./capabilities.js";
import { ProjectTree } from "./project-tree.js";
import { PermissionField, permissionLabel } from "./permissions.js";
import { Modal, ProjectForm, MemberForm, ChannelMembers } from "./workspace.js";
import { Icon, Brand, useDialog, newId } from "./ui.js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { EventReducer, streamEvents } from "./sse.js";
import "./style.css";
type Item = Record<string, any>;
let csrf = "";
async function api(
  path: string,
  body?: unknown,
  method = "POST",
  key = newId(),
): Promise<any> {
  const response = await fetch("/v1" + path, {
    method: body === undefined ? "GET" : method,
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": key,
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message ?? `Request failed (${response.status})`);
  return result;
}
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
const labels: Record<string, string> = {
  idle: "待命",
  working: "工作中",
  starting: "正在启动",
  stopped: "已停止",
  waiting_approval: "等待批准",
  recovering: "恢复中",
  degraded: "需要处理",
  unknown: "状态待核实",
  scheduled: "已排队",
  running: "运行中",
  draining: "正在清理",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  todo: "待领取",
  in_progress: "进行中",
  blocked: "受阻",
  in_review: "待评审",
  done: "已验收",
  cancelled: "已取消",
};
function App() {
  const [logged, setLogged] = useState(false),
    [checking, setChecking] = useState(true),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [passwordEnabled, setPasswordEnabled] = useState(false),
    [loginBusy, setLoginBusy] = useState(false);
  useEffect(() => {
    api("/auth/config")
      .then((r) => setPasswordEnabled(r.passwordEnabled))
      .catch(() => {});
    api("/auth/session")
      .then((r) => {
        csrf = r.csrfToken;
        setLogged(true);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);
  if (checking)
    return (
      <div className="loading">
        Atrium Grove<span>连接工作室…</span>
      </div>
    );
  if (!logged)
    return (
      <div className="login">
        <header className="login-header">
          <Brand />
          <span>协作工作室</span>
        </header>
        <main className="login-main">
          <div className="login-symbol">
            <Icon name="lock" />
          </div>
          <h1>登录工作室</h1>
          <p className="muted">
            {passwordEnabled
              ? "输入密码，继续团队的工作。"
              : "使用本机生成的一次性登录码。"}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setLoginBusy(true);
              setError("");
              try {
                const r = await api(
                  passwordEnabled ? "/auth/password" : "/auth/exchange",
                  passwordEnabled
                    ? { password: token }
                    : { oneTimeToken: token },
                );
                csrf = r.csrfToken;
                setToken("");
                setLogged(true);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setLoginBusy(false);
              }
            }}
          >
            <label htmlFor="login-secret">
              {passwordEnabled ? "登录密码" : "一次性登录码"}
            </label>
            <input
              id="login-secret"
              autoFocus
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete={
                passwordEnabled ? "current-password" : "one-time-code"
              }
              required
              aria-invalid={!!error}
              aria-describedby={error ? "login-error" : undefined}
            />
            {error && (
              <p id="login-error" role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary" disabled={loginBusy}>
              {loginBusy ? "正在登录…" : "进入工作室"}
              <Icon name="arrow" />
            </button>
            {!passwordEnabled && (
              <p className="hint">
                在本机运行 <code>pnpm atrium-grove login-token</code> 获取登录码，有效期 5
                分钟。
              </p>
            )}
          </form>
        </main>
        <footer className="login-footer">
          <span className="status-dot idle" />
          {location.host}
        </footer>
      </div>
    );
  return (
    <Studio
      logout={() => {
        api("/auth/logout", {}).then(() => {
          setLogged(false);
          queryClient.clear();
        });
      }}
    />
  );
}
function Studio({ logout }: { logout: () => void }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState<
    "project" | "member" | "participants" | null
  >(null);
  const [projectId, setProjectId] = useState("");
  const [draftAgents, setDraftAgents] = useState<string[] | null>(null);
  const startDraft = (wsId = workspace, folder = "") => {
    setWorkspace(wsId);
    setChannel("");
    setProjectId(folder);
    setView("chat");
    setSelected(null);
    setModal(null);
    setNavOpen(false);
    setText("");
    setReply(null);
    setAttachments([]);
    setPages([]);
    setMode("all");
  };
  const [editingProject, setEditingProject] = useState<Item | null>(null);
  useEffect(() => {
    if (!modal) setEditingProject(null);
  }, [modal]);
  const { request, dialog } = useDialog();
  const [navOpen, setNavOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [workspace, setWorkspace] = useState(
      () => localStorage.getItem("harbor.workspace") || "",
    ),
    [channel, setChannel] = useState(
      () => new URLSearchParams(location.search).get("conversation") ?? "",
    ),
    [view, setView] = useState("chat"),
    [selected, setSelected] = useState<Item | null>(null),
    [error, setError] = useState(""),
    [connectionError, setConnectionError] = useState(""),
    [text, setText] = useState(""),
    [mode, setMode] = useState("all"),
    [recipients, setRecipients] = useState<string[]>([]),
    [reply, setReply] = useState<Item | null>(null),
    [pages, setPages] = useState<Item[]>([]),
    [attachments, setAttachments] = useState<Item[]>([]),
    [uploading, setUploading] = useState(false),
    [pageCursor, setPageCursor] = useState<string | null | undefined>();
  useEffect(() => {
    const url = new URL(location.href);
    if (channel) url.searchParams.set("conversation", channel);
    else url.searchParams.delete("conversation");
    history.replaceState(null, "", url);
  }, [channel]);
  useEffect(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("harbor.draft-members:" + workspace) ?? "null",
      );
      setDraftAgents(
        Array.isArray(saved)
          ? saved.filter((id) => typeof id === "string")
          : null,
      );
    } catch {
      setDraftAgents(null);
    }
  }, [workspace]);
  const saveDraftAgents = (ids: string[]) => {
    setDraftAgents(ids);
    localStorage.setItem(
      "harbor.draft-members:" + workspace,
      JSON.stringify(ids),
    );
  };
  const messageList = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const followMessages = useRef(true);
  useEffect(() => {
    if (!text && composerInput.current)
      composerInput.current.style.height = "auto";
  }, [text]);
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api("/workspaces"),
  });
  const initializingWorkspace = useRef(false);
  useEffect(() => {
    if (workspaces.data?.items.length === 0 && !initializingWorkspace.current) {
      initializingWorkspace.current = true;
      api("/workspaces", { name: "Atrium Grove" })
        .then((w) => {
          setWorkspace(w.id);
          void qc.invalidateQueries({ queryKey: ["workspaces"] });
        })
        .catch((e) => {
          setError(e.message);
          initializingWorkspace.current = false;
        });
    }
  }, [workspaces.data]);
  useEffect(() => {
    if (
      workspaces.data &&
      !workspaces.data.items.some((w: Item) => w.id === workspace)
    )
      setWorkspace(workspaces.data.items[0]?.id || "");
  }, [workspaces.data, workspace]);
  useEffect(() => {
    if (workspace) localStorage.setItem("harbor.workspace", workspace);
    setSelected(null);
    setRunId("");
  }, [workspace]);
  const projects = useQuery({
    queryKey: ["projects", workspace],
    queryFn: () => api(`/workspaces/${workspace}/projects?limit=200`),
    enabled: !!workspace,
  });
  const members = useQuery({
    queryKey: ["members", channel],
    queryFn: () => api(`/channels/${channel}/members`),
    enabled: !!channel,
  });
  const snapshot = useQuery({
    queryKey: ["snapshot", workspace],
    queryFn: () => api(`/workspaces/${workspace}/snapshot`),
    enabled: !!workspace,
  });
  const snap = snapshot.data;
  useEffect(() => {
    if (selected && snap) {
      const current = snap.agents.find((a: Item) => a.id === selected.id);
      setSelected(current ?? null);
    }
  }, [snap]);
  useEffect(() => {
    if (channel && snap?.channels) {
      const selectedChannel = snap.channels.find((c: Item) => c.id === channel);
      if (selectedChannel) setProjectId(selectedChannel.projectId ?? "");
    }
  }, [channel, snapshot.data]);
  const messages = useQuery({
    queryKey: ["messages", channel],
    queryFn: () => api(`/channels/${channel}/messages?limit=50`),
    refetchInterval: view === "chat" ? 3000 : false,
    enabled: !!channel,
  });
  useEffect(() => {
    setPages([]);
    setPageCursor(undefined);
    setAttachments([]);
    setRecipients([]);
    setReply(null);
    setText("");
  }, [channel]);
  useEffect(() => {
    if (followMessages.current && messageList.current)
      messageList.current.scrollTop = messageList.current.scrollHeight;
  }, [messages.data, pages, view]);
  useEffect(() => {
    followMessages.current = true;
  }, [channel]);
  const tasks = useQuery({
    queryKey: ["tasks", workspace],
    queryFn: () => api(`/workspaces/${workspace}/tasks`),
    enabled: !!workspace,
  });
  const memory = useQuery({
    queryKey: ["memory", workspace],
    queryFn: () => api(`/workspaces/${workspace}/memory`),
    enabled: !!workspace,
  });
  const runs = useQuery({
    queryKey: ["runs", workspace],
    queryFn: () => api(`/workspaces/${workspace}/runs`),
    enabled: !!workspace,
  });
  const chatRuns = useQuery({
    queryKey: ["chat-runs", workspace, channel],
    refetchInterval: view === "chat" ? 2000 : false,
    queryFn: async () => {
      const items: Item[] = [];
      let cursor: string | null = null;
      do {
        const page = await api(
          `/workspaces/${workspace}/runs?channelId=${channel}&limit=200${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
        );
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return items;
    },
    enabled: !!workspace && !!channel,
  });
  const pendingActivity = useQuery({
    queryKey: ["pending-activity", channel],
    queryFn: () => api(`/channels/${channel}/activity`),
    enabled: !!channel && view === "chat",
    refetchInterval: 2000,
  });
  const followActivity = () => {
    if (followMessages.current && messageList.current)
      messageList.current.scrollTop = messageList.current.scrollHeight;
  };
  const [runId, setRunId] = useState("");
  const trace = useQuery({
    queryKey: ["trace", runId],
    queryFn: () => api(`/runs/${runId}/events`),
    enabled: !!runId,
  });
  const stream = useRef(new EventReducer());
  useEffect(() => {
    if (!workspace) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let outage: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const dirty = new Set<string>();
    const pendingTrace = new Map<string, TraceRecord[]>();
    const abort = new AbortController(),
      reducer = stream.current;
    const generation = reducer.begin();
    async function connect(reset = true) {
      try {
        if (reset) {
          const fresh = await api(`/workspaces/${workspace}/snapshot`);
          if (!reducer.snapshot(generation, fresh.snapshotSeq)) return;
          qc.setQueryData(["snapshot", workspace], fresh);
          void qc.invalidateQueries({ queryKey: ["chat-trace"] });
          void qc.invalidateQueries({ queryKey: ["chat-runs", workspace] });
        }
        await streamEvents(
          workspace,
          reducer.seq,
          (event) => {
            if (!reducer.apply(generation, event)) return;
            if (event.type === "run.trace" && event.payload.record?.runId) {
              const record = event.payload.record as TraceRecord;
              const batch = pendingTrace.get(record.runId) ?? [];
              batch.push(record);
              pendingTrace.set(record.runId, batch);
            }
            const prefix = event.type.split(".")[0];
            for (const key of prefix === "message"
              ? ["messages"]
              : event.type === "run.trace"
                ? ["trace"]
                : prefix === "task"
                  ? ["tasks"]
                  : prefix === "memory"
                    ? ["memory"]
                    : [
                        "snapshot",
                        "runs",
                        "chat-runs",
                        "members",
                        "project-chats",
                      ])
              dirty.add(key);
            if (!refresh)
              refresh = setTimeout(() => {
                for (const [id, records] of pendingTrace) {
                  if (
                    qc
                      .getQueryCache()
                      .find({ queryKey: ["chat-trace", id], exact: true })
                      ?.getObserversCount()
                  )
                    qc.setQueryData<TraceRecord[]>(["chat-trace", id], (old) =>
                      mergeTrace(old, records),
                    );
                }
                pendingTrace.clear();
                for (const key of dirty)
                  void qc.invalidateQueries({
                    queryKey:
                      key === "messages" ||
                      key === "trace" ||
                      key === "members" ||
                      key === "project-chats"
                        ? [key]
                        : [key, workspace],
                  });
                dirty.clear();
                refresh = undefined;
              }, 250);
          },
          abort.signal,
          () => {
            clearTimeout(outage);
            outage = undefined;
            attempts = 0;
            setConnectionError("");
          },
        );
      } catch (e) {
        if (stopped) return;
        if ((e as Error).message === "LOGIN_REQUIRED") {
          setConnectionError("登录已过期，请退出后重新登录。");
          return;
        }
        if (!outage)
          outage = setTimeout(
            () => setConnectionError("暂时无法获取新消息，正在重试。"),
            15000,
          );
        timer = setTimeout(
          () => connect((e as Error).message === "REPLAY_WINDOW_EXPIRED"),
          Math.min(1500 * 2 ** attempts++, 15000),
        );
      }
    }
    void connect();
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      clearTimeout(refresh);
      clearTimeout(outage);
      reducer.begin();
    };
  }, [workspace, qc]);
  async function act(path: string, body: Item, method = "POST") {
    try {
      setError("");
      const result = await api(path, body, method);
      await qc.invalidateQueries();
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }
  const agents: Item[] = snap?.agents ?? [],
    approvals: Item[] = snap?.approvals ?? [],
    ws = snap?.workspace;
  const project = projects.data?.items.find((p: Item) => p.id === projectId);
  const availableAgents = agents.filter(
    (a) => !project || a.hostId === project.hostId,
  );
  const channelAgents = channel
    ? agents.filter((a) => members.data?.agentIds.includes(a.id))
    : availableAgents.filter(
        (a) => draftAgents === null || draftAgents.includes(a.id),
      );
  const refreshed = async () => {
    await qc.invalidateQueries();
  };
  const active = (snap?.activeRuns ?? []).length;
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (
      (!text.trim() && !attachments.length) ||
      (!channel && !projectId) ||
      uploading ||
      sending ||
      (mode === "all" && !channelAgents.length) ||
      (mode === "selected" &&
        !recipients.some((id) => channelAgents.some((a) => a.id === id)))
    )
      return;
    setSending(true);
    const payload = {
      blocks: [
        ...(text.trim() ? [{ type: "text", text }] : []),
        ...attachments.map((a) => ({
          type: "artifact",
          artifactId: a.id,
          caption: a.filename,
        })),
      ],
      recipientAgentIds:
        mode === "all"
          ? channelAgents.map((a) => a.id)
          : mode === "selected"
            ? recipients.filter((id) => channelAgents.some((a) => a.id === id))
            : [],
      requestResponse: mode !== "record",
      kind: "message",
      clientMessageId: newId(),
      ...(reply
        ? { replyToMessageId: reply.id, threadId: reply.threadId }
        : {}),
    };
    const result = channel
      ? await act(`/channels/${channel}/messages`, payload)
      : await act(`/workspaces/${workspace}/conversations`, {
          projectId,
          agentIds: channelAgents.map((a) => a.id),
          message: payload,
        });
    if (result && !channel) setChannel(result.channelId);
    setSending(false);
    if (result) {
      setText("");
      setReply(null);
      setAttachments([]);
    }
  }
  return (
    <div
      className={
        "studio" +
        (selected ? " has-inspector" : "") +
        (navOpen ? " nav-open" : "")
      }
    >
      {dialog}
      {modal && (
        <Modal
          title={
            {
              project: editingProject ? "工作目录设置" : "选择工作目录",
              member: "创建成员",
              participants: "参与此对话的成员",
            }[modal]
          }
          close={() => setModal(null)}
        >
          {modal === "project" && (
            <ProjectForm
              api={api}
              workspace={workspace}
              initialProject={editingProject}
              done={(p) => {
                qc.setQueryData(["projects", workspace], (old: any) => ({
                  ...old,
                  items: [
                    ...(old?.items ?? []).filter(
                      (item: Item) => item.id !== p.id,
                    ),
                    p,
                  ],
                }));
                setProjectId(p.id);
                setModal(null);
                void refreshed();
              }}
            />
          )}
          {modal === "member" && (
            <MemberForm
              api={api}
              workspace={workspace}
              projects={projects.data?.items ?? []}
              projectId={projectId}
              channel={channel}
              done={(a) => {
                setModal(null);
                setView("members");
                setSelected(a);
                void refreshed();
              }}
            />
          )}
          {modal === "participants" && (
            <ChannelMembers
              api={api}
              channel={channel}
              agents={agents}
              projects={projects.data?.items ?? []}
              done={() => {
                setModal(null);
                void refreshed();
              }}
            />
          )}
        </Modal>
      )}
      {navOpen && (
        <button
          className="nav-scrim"
          aria-label="关闭导航"
          onClick={() => setNavOpen(false)}
        />
      )}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <a
            href="/"
            aria-label="Atrium Grove 首页"
            onClick={(e) => {
              e.preventDefault();
              startDraft();
            }}
          >
            <Brand />
          </a>
          <button
            className="icon-button mobile-only"
            aria-label="关闭导航"
            onClick={() => setNavOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <button className="new-chat-entry" onClick={() => startDraft()}>
          <Icon name="plus" />
          新对话
        </button>
        <div className="nav-label">项目</div>
        <div className="project-list">
          {workspaces.data?.items.map((w: Item) => (
            <ProjectTree
              key={w.id}
              workspace={w}
              channel={view === "chat" ? channel : ""}
              api={api}
              select={(id, chat) => {
                setWorkspace(id);
                setChannel(chat);
                setView("chat");
                setSelected(null);
                setNavOpen(false);
              }}
              createChat={(id, folder) => startDraft(id, folder)}
            />
          ))}
        </div>
        <div className="nav-label section-space">工作台</div>
        <nav>
          {[
            ["members", "", "成员"],
            ["tasks", "▦", "任务"],
            ["runs", "≋", "运行记录"],
            ["approvals", "◇", "审批中心"],
            ["memory", "▤", "共享记忆"],
            ["hosts", "⌘", "执行电脑"],
            ["settings", "", "项目设置"],
          ].map(([id, icon, label]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              aria-current={view === id ? "page" : undefined}
              onClick={() => {
                setView(id!);
                setNavOpen(false);
              }}
            >
              <Icon name={id!} />
              <span>{label}</span>
              {id === "approvals" && approvals.length > 0 && (
                <em>{approvals.length}</em>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button onClick={logout}>
            <Icon name="exit" />
            退出登录
          </button>
        </div>
      </aside>
      <main id="main-content">
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            aria-label="打开导航"
            onClick={() => setNavOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="page-title">
            {(view !== "chat" || channel) && (
              <h1>
                {view === "chat"
                  ? (snap?.channels.find((c: Item) => c.id === channel)?.name ??
                    "")
                  : (
                      {
                        tasks: "任务",
                        members: "成员",
                        settings: "项目设置",
                        runs: "运行记录",
                        approvals: "审批中心",
                        memory: "共享记忆",
                        hosts: "执行电脑",
                      } as Item
                    )[view]}
              </h1>
            )}
          </div>
          <div className="top-actions">
            {active > 0 && (
              <button className="activity" onClick={() => setView("runs")}>
                {active} 项执行中
              </button>
            )}
            {workspace && channel && view === "chat" && (
              <button onClick={() => setModal("participants")}>
                参与者{channelAgents.length ? ` · ${channelAgents.length}` : ""}
              </button>
            )}
            {workspace && view === "members" && (
              <button
                className="primary"
                onClick={() =>
                  setModal(projects.data?.items.length ? "member" : "project")
                }
              >
                <Icon name="plus" />
                创建成员
              </button>
            )}
          </div>
        </header>
        {connectionError && (
          <div className="inline-state error" role="alert">
            {connectionError}
          </div>
        )}
        {error && (
          <div className="error banner" role="alert">
            {error}
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => setError("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {workspace && snapshot.isError && (
          <QueryFeedback query={snapshot} label="工作室" />
        )}
        {workspace && view === "members" && (
          <section className="content-panel member-page">
            {!agents.length ? (
              <div className="start-state">
                <p>尚未创建成员</p>
                <button
                  onClick={() =>
                    setModal(projects.data?.items.length ? "member" : "project")
                  }
                >
                  {projects.data?.items.length ? "创建成员" : "先选择工作目录"}
                </button>
              </div>
            ) : (
              <div className="member-table">
                {agents.map((a) => (
                  <button
                    key={a.id}
                    className="member-row"
                    onClick={() => setSelected(a)}
                  >
                    <div>
                      <strong>{a.name}</strong>
                      <span>
                        {a.runtime.driver === "codex-app-server"
                          ? "Codex"
                          : "Claude Code"}{" "}
                        {a.runtime.model !== "default" &&
                          ` · ${a.runtime.model}`}
                      </span>
                    </div>
                    <span className="member-path">
                      {
                        projects.data?.items.find(
                          (p: Item) => p.id === a.projectId,
                        )?.rootPath
                      }
                    </span>
                    <Icon name="arrow" />
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        {workspace && view === "settings" && (
          <section className="content-panel settings-page">
            <h2>工作目录</h2>
            {projects.data?.items.map((p: Item) => (
              <div className="project-row" key={p.id}>
                <strong>{p.name}</strong>
                <code>{p.rootPath}</code>
                <span className="hint">
                  {p.workspaceMode === "git-worktree"
                    ? "Git 工作副本"
                    : "共享文件夹"}
                </span>
                <button
                  onClick={() => {
                    setEditingProject(p);
                    setModal("project");
                  }}
                >
                  设置
                </button>
              </div>
            ))}
            <button onClick={() => setModal("project")}>添加工作目录</button>
            <section className="execution-setting">
              <h2>新执行</h2>
              <p>
                暂停后，不再启动新的成员会话或消息处理。正在执行的工作会继续，任务分配保持原样。
              </p>
              <button
                onClick={() =>
                  void act(`/workspaces/${workspace}/control`, {
                    action: ws.state === "paused" ? "resume" : "pause",
                    expectedVersion: ws.version,
                  })
                }
              >
                {ws?.state === "paused" ? "恢复新执行" : "暂停新执行"}
              </button>
            </section>
          </section>
        )}
        {workspace && view === "chat" && (
          <div
            className={
              "conversation" +
              (!messages.data?.items.length && !pages.length ? " is-empty" : "")
            }
          >
            {channel && messages.isPending ? (
              <div className="inline-state" role="status">
                正在读取消息…
              </div>
            ) : messages.isError ? (
              <div className="inline-state error" role="alert">
                消息读取失败。
                <button onClick={() => void messages.refetch()}>重试</button>
              </div>
            ) : null}
            <div
              className="message-list"
              ref={messageList}
              onScroll={(e) => {
                const el = e.currentTarget;
                followMessages.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 100;
              }}
            >
              {[...(messages.data?.items ?? []), ...pages].map((m: Item) => (
                <article
                  className={
                    "message " +
                    (m.actor.kind === "human" ? "from-human" : "from-agent")
                  }
                  key={m.id}
                >
                  <div className="message-body">
                    <div className="message-meta">
                      <strong>{m.actor.displayName}</strong>
                      <time>
                        {new Date(m.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                    {m.runId &&
                      chatRuns.data?.some(
                        (r: Item) =>
                          r.id === m.runId && r.finalMessageId === m.id,
                      ) && (
                        <RunActivity
                          run={
                            chatRuns.data.find((r: Item) => r.id === m.runId)!
                          }
                          api={api}
                          finalText={m.blocks
                            .filter((b: Item) => b.type === "text")
                            .map((b: Item) => b.text)
                            .join("\n")}
                          onUpdate={followActivity}
                          onInspect={() => {
                            setRunId(m.runId);
                            setView("runs");
                          }}
                        />
                      )}
                    {m.blocks.map((b: Item, i: number) =>
                      b.type === "text" ? (
                        <div key={i} className="message-text">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            skipHtml
                            components={{
                              a: ({ children, href }) => (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {children}
                                </a>
                              ),
                              img: ({ alt }) => <span>[图片：{alt}]</span>,
                            }}
                          >
                            {b.text}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <a
                          key={i}
                          className="artifact"
                          href={`/v1/artifacts/${b.artifactId}/content`}
                        >
                          ↗ {b.caption ?? "查看工件"}
                        </a>
                      ),
                    )}
                    <div className="message-actions">
                      <button onClick={() => setReply(m)}>回复</button>
                      <button
                        onClick={async () => {
                          let threadId = m.threadId;
                          if (!threadId) {
                            const t = await act(
                              `/channels/${m.channelId}/threads`,
                              {
                                title:
                                  m.blocks
                                    .find((b: Item) => b.type === "text")
                                    ?.text.slice(0, 60) ?? "任务讨论",
                              },
                            );
                            if (!t) return;
                            threadId = t.id;
                          }
                          const title = await request(
                            "任务标题",
                            "保留原消息作为任务来源，并进入独立评审流程。",
                          );
                          if (title)
                            await act(`/workspaces/${workspace}/tasks`, {
                              channelId: m.channelId,
                              threadId,
                              sourceMessageId: m.id,
                              title,
                              description: m.blocks
                                .filter((b: Item) => b.type === "text")
                                .map((b: Item) => b.text)
                                .join("\n"),
                              acceptanceCriteria: [
                                "提供实现与测试证据，并通过独立评审",
                              ],
                            });
                        }}
                      >
                        转为任务
                      </button>
                      <span>
                        {m.requestResponse
                          ? `已保存 · 通知 ${m.recipientAgentIds.length} 位成员`
                          : "已保存 · 仅记录"}
                      </span>
                    </div>
                  </div>
                </article>
              ))}
              {chatRuns.isError && (
                <p className="error" role="alert">
                  执行状态读取失败，正在重试。
                  <button onClick={() => void chatRuns.refetch()}>重试</button>
                </p>
              )}
              {pendingActivity.isError && (
                <p className="error" role="alert">
                  等待状态读取失败，正在重试。
                </p>
              )}
              {pendingActivity.data?.items.map((item: Item) => (
                <article
                  className="message from-agent pending-response"
                  key={item.id}
                >
                  <div className="message-body">
                    <div className="message-meta">
                      <strong>{item.agentName}</strong>
                    </div>
                    <div className="activity-status" role="status">
                      {pendingActivityLabel(item)}
                    </div>
                  </div>
                </article>
              ))}
              {chatRuns.data
                ?.filter((r: Item) => !r.finalMessageId)
                .sort((a: Item, b: Item) =>
                  (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
                )
                .map((r: Item) => (
                  <article key={r.id} className="message from-agent">
                    <div className="message-body">
                      <div className="message-meta">
                        <strong>
                          {agents.find((a) => a.id === r.agentId)?.name ??
                            "成员"}
                        </strong>
                      </div>
                      <RunActivity
                        run={r}
                        api={api}
                        onUpdate={followActivity}
                        onInspect={() => {
                          setRunId(r.id);
                          setView(
                            r.state === "waiting_approval"
                              ? "approvals"
                              : "runs",
                          );
                        }}
                      />
                    </div>
                  </article>
                ))}
            </div>
            {(pageCursor === undefined
              ? messages.data?.nextCursor
              : pageCursor) && (
              <button
                className="load-more"
                onClick={async () => {
                  const page = await api(
                    `/channels/${channel}/messages?cursor=${encodeURIComponent(pageCursor ?? messages.data.nextCursor)}`,
                  );
                  setPageCursor(page.nextCursor);
                  setPages((p) => [
                    ...p,
                    ...page.items.map((x: Item) => ({
                      ...x,
                      _next: page.nextCursor,
                    })),
                  ]);
                }}
              >
                加载后续消息
              </button>
            )}
            <form className="composer" onSubmit={send}>
              {reply && (
                <div className="replying">
                  回复 {reply.actor.displayName}
                  <button type="button" onClick={() => setReply(null)}>
                    取消
                  </button>
                </div>
              )}
              <textarea
                ref={composerInput}
                value={text}
                rows={1}
                onChange={(e) => {
                  setText(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height =
                    Math.min(e.target.scrollHeight, 200) + "px";
                }}
                placeholder="输入消息…"
                aria-label="消息正文"
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    e.nativeEvent.keyCode !== 229
                  ) {
                    e.preventDefault();
                    if (!e.repeat) void send(e);
                  }
                }}
              />
              {attachments.length > 0 && (
                <div className="recipient-picker">
                  {attachments.map((a) => (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() =>
                        setAttachments((items) =>
                          items.filter((x) => x.id !== a.id),
                        )
                      }
                    >
                      {a.filename} ×
                    </button>
                  ))}
                </div>
              )}
              <div className="composer-tools">
                <label
                  className="attachment-picker"
                  title={uploading ? "上传中…" : "添加附件"}
                >
                  <Icon name="plus" />
                  <span className="sr-only">添加附件</span>
                  <input
                    type="file"
                    multiple
                    disabled={uploading}
                    onChange={async (e) => {
                      const files = Array.from(e.target.files ?? []);
                      if (files.length + attachments.length > 16) {
                        setError("每条消息最多 16 个附件");
                        return;
                      }
                      setUploading(true);
                      try {
                        for (const file of files) {
                          if (file.size > 25 * 1024 * 1024)
                            throw new Error("单个工件不得超过 25 MiB");
                          const response = await fetch(
                            `/v1/workspaces/${workspace}/artifacts`,
                            {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/octet-stream",
                                "X-CSRF-Token": csrf,
                                "Idempotency-Key": newId(),
                                "X-Filename": encodeURIComponent(file.name),
                              },
                              body: file,
                            },
                          );
                          const result = await response.json();
                          if (!response.ok) throw new Error(result.message);
                          setAttachments((items) => [...items, result]);
                        }
                      } catch (error) {
                        setError(String(error));
                      } finally {
                        setUploading(false);
                        e.target.value = "";
                      }
                    }}
                  />
                </label>
                <div
                  className="directory-context"
                  title={project?.rootPath || "选择工作目录"}
                >
                  <Icon name="folder" />
                  <select
                    aria-label="当前工作目录"
                    value={projectId}
                    disabled={!!channel}
                    onChange={(e) =>
                      e.target.value === "__add"
                        ? setModal("project")
                        : setProjectId(e.target.value)
                    }
                  >
                    {!projectId && <option value="">工作目录</option>}
                    {projects.data?.items.map((p: Item) => (
                      <option key={p.id} value={p.id}>
                        {p.rootPath.split("/").filter(Boolean).at(-1) ||
                          p.rootPath}
                        {p.workspaceMode === "git-worktree" ? " · Git" : ""}
                      </option>
                    ))}
                    <option value="__add">选择其他本机目录…</option>
                  </select>
                </div>
                <div className="composer-bottom">
                  {!channel ? (
                    <details className="draft-participants">
                      <summary>
                        参与成员
                        {channelAgents.length
                          ? ` · ${channelAgents.length}`
                          : ""}
                      </summary>
                      <div className="draft-participant-menu">
                        {availableAgents.map((a) => (
                          <label key={a.id}>
                            <input
                              type="checkbox"
                              checked={channelAgents.some((m) => m.id === a.id)}
                              onChange={(e) =>
                                saveDraftAgents(
                                  e.target.checked
                                    ? [...channelAgents.map((m) => m.id), a.id]
                                    : channelAgents
                                        .filter((m) => m.id !== a.id)
                                        .map((m) => m.id),
                                )
                              }
                            />
                            <span>{a.name}</span>
                          </label>
                        ))}
                        {!availableAgents.length && (
                          <button
                            type="button"
                            onClick={() => setView("members")}
                          >
                            前往成员页添加成员
                          </button>
                        )}
                      </div>
                    </details>
                  ) : (
                    <select
                      aria-label="通知方式"
                      value={mode}
                      onChange={(e) => setMode(e.target.value)}
                    >
                      <option value="all">所有参与者</option>
                      <option value="selected">选择收件人</option>
                      <option value="record">仅记录</option>
                    </select>
                  )}

                  <button
                    className="primary send-button"
                    aria-label={sending ? "发送中" : "发送消息"}
                    title="Enter 发送，Shift+Enter 换行"
                    disabled={
                      (!text.trim() && !attachments.length) ||
                      (!channel && !projectId) ||
                      uploading ||
                      sending ||
                      (mode === "selected" &&
                        recipients.filter((id) =>
                          channelAgents.some((a) => a.id === id),
                        ).length === 0) ||
                      (mode === "all" && channelAgents.length === 0)
                    }
                  >
                    <Icon name="send" />
                  </button>
                </div>
              </div>
              {mode === "selected" && (
                <div className="recipient-picker">
                  {channelAgents.map((a) => (
                    <label key={a.id}>
                      <input
                        type="checkbox"
                        checked={recipients.includes(a.id)}
                        onChange={(e) =>
                          setRecipients((p) =>
                            e.target.checked
                              ? [...p, a.id]
                              : p.filter((x) => x !== a.id),
                          )
                        }
                      />
                      {a.name}
                    </label>
                  ))}
                </div>
              )}
            </form>
          </div>
        )}
        {workspace && view === "tasks" && (
          <QueryFeedback query={tasks} label="任务" />
        )}
        {workspace && view === "tasks" && (
          <div className="board">
            {["todo", "in_progress", "blocked", "in_review", "done"].map(
              (status) => (
                <section className="board-column" key={status}>
                  <h3>
                    {labels[status]}{" "}
                    <span>
                      {tasks.data?.items.filter(
                        (t: Item) => t.status === status,
                      ).length ?? 0}
                    </span>
                  </h3>
                  {!tasks.isPending &&
                    !tasks.data?.items.some(
                      (t: Item) => t.status === status,
                    ) && <p className="column-empty">暂无任务</p>}
                  {tasks.data?.items
                    .filter((t: Item) => t.status === status)
                    .map((t: Item) => (
                      <div className="task-card" key={t.id}>
                        <small>版本 {t.version}</small>
                        <h4>{t.title}</h4>
                        <div className="task-description">
                          <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]}>
                            {t.description}
                          </ReactMarkdown>
                        </div>
                        <span className="muted">
                          {agents.find((a) => a.id === t.assigneeAgentId)
                            ?.name ?? "尚未领取"}
                        </span>
                        {status === "todo" && (
                          <select
                            aria-label="分配任务"
                            defaultValue=""
                            onChange={(e) => {
                              if (e.target.value)
                                void act(`/tasks/${t.id}/claim`, {
                                  agentId: e.target.value,
                                  expectedVersion: t.version,
                                });
                            }}
                          >
                            <option value="">分配给…</option>
                            {agents.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        )}
                        {status === "in_review" && (
                          <button
                            onClick={async () => {
                              const reason = await request(
                                "验收说明",
                                "说明证据与验收结论。",
                              );
                              if (reason)
                                void act(`/tasks/${t.id}/transition`, {
                                  status: "done",
                                  expectedVersion: t.version,
                                  leaseEpoch: t.leaseEpoch,
                                  artifactIds: t.artifactIds,
                                  reason,
                                });
                            }}
                          >
                            验收完成
                          </button>
                        )}
                        <div className="task-evidence">
                          {t.artifactIds.length} 个证据
                        </div>
                      </div>
                    ))}
                </section>
              ),
            )}
          </div>
        )}
        {workspace && view === "runs" && (
          <section className="content-panel">
            <QueryFeedback query={runs} label="运行记录" />
            {runs.data?.items.length === 0 && (
              <Empty
                title="还没有运行记录"
                text="成员开始执行任务后，状态与事件将显示在这里。"
              />
            )}
            {runs.data?.items.map((r: Item) => (
              <button
                className={"run-row" + (runId === r.id ? " selected" : "")}
                key={r.id}
                onClick={() => setRunId(r.id)}
              >
                <span>{agents.find((a) => a.id === r.agentId)?.name}</span>
                <span className={"tag state-" + r.state}>
                  {labels[r.state] ?? r.state}
                </span>
                <time>
                  {r.startedAt
                    ? new Date(r.startedAt).toLocaleString()
                    : "等待派发"}
                </time>
                <span className="row-link">
                  查看轨迹
                  <Icon name="arrow" />
                </span>
              </button>
            ))}
            {runId && (
              <div className="trace">
                <div className="trace-header">
                  <h3>运行轨迹</h3>
                  <button
                    onClick={() =>
                      void act(`/runs/${runId}/control`, {
                        action: "interrupt",
                        clientMessageId: newId(),
                      })
                    }
                  >
                    请求中断
                  </button>
                  <button
                    onClick={() =>
                      void act(`/runs/${runId}/control`, {
                        action: "reconcile",
                        clientMessageId: newId(),
                      })
                    }
                  >
                    核实状态
                  </button>
                </div>
                {trace.data?.items.map((r: Item) => (
                  <details key={r.id}>
                    <summary>
                      {r.kind}{" "}
                      <small>
                        {r.lane.length ? r.lane.join(" / ") : "根回合"}
                      </small>
                    </summary>
                    <pre>{JSON.stringify(r.payload, null, 2)}</pre>
                  </details>
                ))}
              </div>
            )}
          </section>
        )}
        {workspace && view === "approvals" && (
          <section className="content-panel">
            <QueryFeedback query={snapshot} label="审批" />
            {approvals.length === 0 &&
            !snapshot.isPending &&
            !snapshot.isError ? (
              <Empty
                title="没有待处理的审批"
                text="需要你的决定时，原版请求会出现在这里。"
              />
            ) : (
              approvals.map((a: Item) => (
                <Approval
                  key={a.id}
                  approval={a}
                  decide={(b) => act(`/approvals/${a.id}/resolve`, b)}
                />
              ))
            )}
          </section>
        )}
        {workspace && view === "memory" && (
          <section className="content-panel">
            <QueryFeedback query={memory} label="共享记忆" />
            {memory.data?.items.length === 0 && (
              <Empty
                title="还没有共享记忆"
                text="Agent 提交的提案经过你的接受后，才会进入共享上下文。"
              />
            )}
            {memory.data?.items.map((m: Item) => (
              <article className="memory-card" key={m.id}>
                <span className="tag">{m.status}</span>
                <h3>{m.title}</h3>
                <div className="memory-body">
                  <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]}>
                    {m.body}
                  </ReactMarkdown>
                </div>
                <small>
                  {m.sourceMessageIds.length} 条来源 · v{m.version}
                </small>
                {m.status === "proposed" && (
                  <button
                    onClick={() =>
                      void act(`/memory/${m.id}/decision`, {
                        action: "accept",
                        expectedVersion: m.version,
                      })
                    }
                  >
                    接受提案
                  </button>
                )}
              </article>
            ))}
          </section>
        )}
        {workspace && view === "hosts" && <Hosts />}
      </main>
      {selected && (
        <aside className="inspector" aria-label="成员详情">
          <div className="inspector-heading">
            <span>成员详情</span>
            <button
              className="icon-button"
              aria-label="关闭成员详情"
              onClick={() => setSelected(null)}
            >
              <Icon name="close" />
            </button>
          </div>
          <h2>{selected.name}</h2>
          <span className="tag">
            {selected.runtime.driver === "codex-app-server"
              ? "Codex"
              : "Claude Code"}
          </span>
          <p>{selected.role}</p>
          <div className="member-directory">
            <span>工作目录</span>
            <code>
              {projects.data?.items.find(
                (p: Item) => p.id === selected.projectId,
              )?.rootPath ?? "未读取"}
            </code>
            <span className="hint">
              {projects.data?.items.find(
                (p: Item) => p.id === selected.projectId,
              )?.workspaceMode === "git-worktree"
                ? "Git 工作副本"
                : "直接在此文件夹工作"}
            </span>
          </div>
          <dl>
            <dt>模型</dt>
            <dd>
              {selected.runtime.model === "default"
                ? "沿用 CLI 配置"
                : selected.runtime.model}
            </dd>
            <dt>权限</dt>
            <dd>{permissionLabel(selected.runtime.permissionProfile)}</dd>
            <dt>Computer Use</dt>
            <dd>
              {["auto-approve", "full-access"].includes(
                selected.runtime.permissionProfile,
              ) && selected.capabilities.includes("desktop.request")
                ? "开启"
                : "关闭"}
            </dd>
          </dl>
          <AgentEditor
            key={`${selected.id}:${selected.version}`}
            agent={selected}
            save={(body) => act(`/agents/${selected.id}`, body, "PATCH")}
            remove={() =>
              act(
                `/agents/${selected.id}`,
                { expectedVersion: selected.version },
                "DELETE",
              )
            }
          />
        </aside>
      )}
    </div>
  );
}
function QueryFeedback({
  query,
  label,
}: {
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  label: string;
}) {
  if (query.isPending)
    return (
      <div className="inline-state" role="status">
        正在读取{label}…
      </div>
    );
  if (query.isError)
    return (
      <div className="inline-state error" role="alert">
        {label}读取失败，请检查连接。
        <button onClick={() => void query.refetch()}>重试</button>
      </div>
    );
  return null;
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <Icon name="chat" />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
function AgentEditor({
  agent,
  save,
  remove,
}: {
  agent: Item;
  save: (body: Item) => Promise<any>;
  remove: () => Promise<any>;
}) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role),
    [model, setModel] = useState(agent.runtime.model),
    [permission, setPermission] = useState(agent.runtime.permissionProfile),
    [capabilities, setCapabilities] = useState<string[]>(agent.capabilities),
    [busy, setBusy] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <>
      <details className="agent-editor">
        <summary>编辑成员配置</summary>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await save({
                expectedVersion: agent.version,
                name,
                role,
                runtime: {
                  ...agent.runtime,
                  model,
                  permissionProfile: permission,
                },
                capabilities,
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="hint">
            配置保存后，在下一次执行时生效。正在执行时需等待本轮完成。
          </p>
          <label>
            名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label>
            职责
            <textarea
              value={role}
              onChange={(e) => setRole(e.target.value)}
              required
            />
          </label>
          <label>
            模型
            <input
              value={model === "default" ? "" : model}
              onChange={(e) => setModel(e.target.value || "default")}
              placeholder="使用 CLI 配置的模型"
            />
          </label>
          <PermissionField
            value={permission}
            onChange={(mode) => {
              setPermission(mode);
              if (!["auto-approve", "full-access"].includes(mode))
                setCapabilities((current) =>
                  current.filter((c) => c !== "desktop.request"),
                );
            }}
          />
          <ComputerUseField
            value={capabilities}
            onChange={setCapabilities}
            permission={permission}
          />
          <CapabilityField value={capabilities} onChange={setCapabilities} />
          <button
            disabled={
              busy || !["stopped", "idle"].includes(agent.observedState)
            }
          >
            保存配置
          </button>
        </form>
      </details>
      <div className="agent-delete">
        {confirmDelete ? (
          <div role="group" aria-label="确认删除成员">
            <p>删除「{agent.name}」？</p>
            <p className="hint">
              会从所有对话中移除此成员。历史消息、运行记录和工作文件保留。
            </p>
            <div className="agent-delete-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await remove();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "正在删除…" : "确认删除"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            删除成员
          </button>
        )}
      </div>
    </>
  );
}
function Approval({
  approval: a,
  decide,
}: {
  approval: Item;
  decide: (b: Item) => Promise<any>;
}) {
  const [content, setContent] = useState("{}"),
    [busy, setBusy] = useState(false),
    [scope, setScope] = useState("once"),
    [error, setError] = useState("");
  return (
    <article className="approval-card">
      <span className="tag">
        {a.source} · {a.kind}
      </span>
      <h3>{a.title}</h3>
      {a.source === "computer-use" ? (
        <p>
          {a.display?._meta?.tool_params?.app
            ? `请求操作应用：${a.display._meta.tool_params.app}`
            : "电脑操作需要你的批准。"}
        </p>
      ) : (
        <pre>{JSON.stringify(a.display, null, 2)}</pre>
      )}
      {a.source === "computer-use" &&
        (a.display?._meta?.warningSubtitle || a.display?._meta?.subtitle) && (
          <p className="hint">
            {a.display._meta.warningSubtitle || a.display._meta.subtitle}
          </p>
        )}
      {a.kind !== "permission" &&
        !(
          a.source === "computer-use" &&
          Object.keys(a.inputSchema?.properties ?? {}).length === 0
        ) && (
          <label>
            响应内容
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
        )}
      {a.source === "computer-use" &&
        a.display?._meta?.persist?.includes("session") && (
          <label>
            应用授权时长
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="once">仅这次操作</option>
              <option value="session">当前电脑操作会话</option>
            </select>
          </label>
        )}
      {error && <p className="error">{error}</p>}
      <div>
        {["approve", "deny", "cancel"]
          .filter((action) => a.allowedActions.includes(action))
          .map((action) => (
            <button
              key={action}
              disabled={busy}
              className={action === "approve" ? "primary" : ""}
              onClick={async () => {
                try {
                  const parsed = JSON.parse(content);
                  setBusy(true);
                  await decide({
                    action,
                    content: parsed,
                    scope,
                    expectedVersion: a.version,
                    argumentHash: a.argumentHash,
                  });
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {action === "approve"
                ? scope === "session"
                  ? "允许当前会话"
                  : "允许一次"
                : action === "deny"
                  ? "拒绝"
                  : "取消"}
            </button>
          ))}
      </div>
    </article>
  );
}
function Hosts() {
  const hosts = useQuery({ queryKey: ["hosts"], queryFn: () => api("/hosts") });
  return (
    <section className="content-panel">
      <QueryFeedback query={hosts} label="主机" />
      {hosts.data?.items.length === 0 && (
        <Empty
          title="尚未注册主机"
          text="在执行电脑上运行 pnpm atrium-grove init，再启动 pnpm atrium-grove host start。"
        />
      )}
      {hosts.data?.items.map((h: Item) => (
        <HostCard key={h.id} host={h} />
      ))}
    </section>
  );
}
function HostCard({ host: h }: { host: Item }) {
  const desktop = useQuery({
    queryKey: ["desktop", h.id],
    queryFn: () => api(`/hosts/${h.id}/desktop`),
    refetchInterval: 5000,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [operationId, setOperationId] = useState<string | null>(null);
  const operation = useQuery({
    queryKey: ["desktop-operation", operationId],
    enabled: !!operationId,
    queryFn: () => api(`/operations/${operationId}`),
    refetchInterval: (q) =>
      ["completed", "failed", "unknown"].includes(q.state.data?.state)
        ? false
        : 1000,
  });
  const control = async (action: string) => {
    setBusy(true);
    setError("");
    try {
      const op = await api(`/hosts/${h.id}/desktop/control`, {
        action,
        reason: "用户在执行电脑页面请求",
      });
      setOperationId(op.id);
      await desktop.refetch();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const inventory = useQuery({
    queryKey: ["inventory", h.id],
    queryFn: () => api(`/hosts/${h.id}/inventory`),
  });
  const owner = useQuery({
    queryKey: ["desktop-owner", desktop.data?.ownerAgentId],
    enabled: !!desktop.data?.ownerAgentId,
    queryFn: () => api(`/agents/${desktop.data.ownerAgentId}`),
  });
  return (
    <article className="host-card">
      <h2>{h.name}</h2>
      {h.state !== "online" && <p className="error">执行服务离线</p>}
      <h3>Computer Use</h3>
      <p className="muted">
        在成员配置中单独开启，需要 Auto Approve 或 Full Access。
      </p>
      <p>
        {(
          {
            unavailable: "尚未就绪",
            free: "空闲",
            held: "正在操作电脑",
            draining: "正在停止并释放桌面",
            quarantined: "桌面释放未确认",
          } as Record<string, string>
        )[desktop.data?.state] ?? "正在读取状态…"}
      </p>
      <p className="muted">
        {desktop.data?.provider === "disabled"
          ? "尚未配置电脑操作组件。请在执行电脑上运行 pnpm exec tsx scripts/setup-computer.ts。"
          : desktop.data?.diagnostic}
      </p>
      {desktop.data?.ownerRunId && (
        <p>
          当前成员：{owner.data?.name ?? "正在读取…"} ·{" "}
          {desktop.data.inFlightCalls} 项操作进行中
        </p>
      )}
      {desktop.data?.state === "quarantined" && (
        <p className="muted">
          未收到原组件的释放确认前，不会让其他成员接管。重新检查不会强制解除占用。
        </p>
      )}
      <div className="desktop-controls">
        <button
          disabled={busy || !["held", "draining"].includes(desktop.data?.state)}
          onClick={() => void control("stop")}
        >
          停止当前电脑操作
        </button>
        {desktop.data?.state === "quarantined" && (
          <button
            disabled={busy}
            onClick={() => void control("clear_quarantine")}
          >
            重新确认释放
          </button>
        )}
        <button disabled={busy} onClick={() => void desktop.refetch()}>
          刷新状态
        </button>
      </div>
      {operation.data && (
        <p role="status">
          {(
            {
              pending: "等待执行电脑响应…",
              running: "正在处理…",
              completed: "请求已处理",
              failed: "请求失败",
              unknown: "结果尚未确认",
            } as Record<string, string>
          )[operation.data.state] ?? "正在处理…"}
          {operation.data.error?.message
            ? `：${operation.data.error.message}`
            : ""}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <details className="host-components">
        <summary>组件信息</summary>
        <p className="muted">
          {h.platform} / {h.architecture}
        </p>
        {inventory.data?.entries.map((e: Item) => (
          <div className="inventory-row" key={e.driver}>
            <strong>
              {e.driver === "codex-app-server" ? "Codex" : "Claude Code"}
            </strong>
            <span>{e.version ?? "不可用"}</span>
            {!e.available && <small>{e.diagnostic}</small>}
          </div>
        ))}
      </details>
    </article>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
