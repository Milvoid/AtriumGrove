import { translate, translateError } from "./i18n.js";
import {
  defaultCapabilities,
  CapabilityField,
  ComputerUseField,
} from "./capabilities.js";
import { PermissionField } from "./permissions.js";
import { useState, useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "./ui.js";
type Item = Record<string, any>;
type Api = (path: string, body?: unknown, method?: string) => Promise<any>;
export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog workspace-dialog"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={translate("关闭对话框")}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function DirectoryPicker({
  api,
  hostId,
  value,
  onChange,
}: {
  api: Api;
  hostId: string;
  value: string;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [path, setPath] = useState(""),
    [input, setInput] = useState("");
  const dir = useQuery({
    queryKey: ["directories", hostId, path],
    queryFn: () =>
      api(
        `/hosts/${hostId}/directories${path ? "?path=" + encodeURIComponent(path) : ""}`,
      ),
    enabled: open && !!hostId,
    retry: false,
  });
  useEffect(() => {
    if (dir.data) setInput(dir.data.path);
  }, [dir.data]);
  return (
    <>
      <label>
        {translate("本机工作目录")}
        <div className="directory-field">
          <input
            aria-label={translate("本机工作目录")}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={translate("选择或填写文件夹路径")}
            required
          />
          <button
            type="button"
            disabled={!hostId}
            onClick={() => {
              setPath(value);
              setOpen(true);
            }}
          >
            {translate("浏览…")}
          </button>
        </div>
      </label>
      {open && (
        <Modal title={translate("选择工作目录")} close={() => setOpen(false)}>
          <div className="directory-location">
            <input
              aria-label={translate("转到目录")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setPath(input);
                }
              }}
            />
            <button type="button" onClick={() => setPath(input)}>
              {translate("转到")}
            </button>
          </div>
          {dir.isError && (
            <p role="alert" className="error">
              {translateError((dir.error as Error).message)}
            </p>
          )}
          {dir.isPending ? (
            <p>{translate("正在读取目录…")}</p>
          ) : (
            dir.data && (
              <>
                <div className="directory-toolbar">
                  <button
                    type="button"
                    disabled={!dir.data.parent}
                    onClick={() => setPath(dir.data.parent)}
                  >
                    {translate("上一级")}
                  </button>
                </div>
                <div className="directory-list">
                  {dir.data.entries.map((d: Item) => (
                    <button
                      type="button"
                      key={d.path}
                      onClick={() => setPath(d.path)}
                    >
                      <Icon name="folder" />
                      <span>{d.name}</span>
                      <Icon name="arrow" />
                    </button>
                  ))}
                  {!dir.data.entries.length && (
                    <p className="muted">{translate("没有子文件夹")}</p>
                  )}
                  {dir.data.truncated && (
                    <p className="muted">
                      {translate(
                        "仅显示前 500 个文件夹，可在上方输入完整路径。",
                      )}
                    </p>
                  )}
                </div>
                <div className="form-actions">
                  <button type="button" onClick={() => setOpen(false)}>
                    {translate("取消")}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={dir.isFetching}
                    onClick={() => {
                      onChange(dir.data.path);
                      setOpen(false);
                    }}
                  >
                    {translate("使用此目录")}
                  </button>
                </div>
              </>
            )
          )}
        </Modal>
      )}
    </>
  );
}
export function ProjectForm({
  api,
  workspace,
  done,
  initialProject,
}: {
  api: Api;
  workspace: string;
  done: (p: Item) => void;
  initialProject?: Item | null;
}) {
  const hosts = useQuery({ queryKey: ["hosts"], queryFn: () => api("/hosts") });
  const projects = useQuery({
    queryKey: ["projects", workspace],
    queryFn: () => api(`/workspaces/${workspace}/projects`),
  });
  const [hostId, setHostId] = useState(initialProject?.hostId ?? ""),
    [root, setRoot] = useState(initialProject?.rootPath ?? ""),
    [useGit, setUseGit] = useState(
      initialProject?.workspaceMode === "git-worktree",
    ),
    [busy, setBusy] = useState(false),
    [initializing, setInitializing] = useState(false),
    [error, setError] = useState("");
  const pendingInit = useRef<string | null>(null);
  const git = useQuery({
    queryKey: ["git-association", hostId, root],
    queryFn: () =>
      api(
        `/hosts/${hostId}/directories?path=${encodeURIComponent(root)}&git=true`,
      ),
    enabled: useGit && !!hostId && !!root,
    retry: false,
  });
  useEffect(() => {
    if (!hostId && hosts.data?.items[0]) setHostId(hosts.data.items[0].id);
  }, [hosts.data, hostId]);
  const existing = projects.data?.items.find(
    (p: Item) => p.hostId === hostId && p.rootPath === root,
  );
  const changedMode =
    existing &&
    existing.workspaceMode !== (useGit ? "git-worktree" : "directory");
  async function initialize() {
    setInitializing(true);
    setError("");
    try {
      const operation =
        pendingInit.current ??
        (await api(`/hosts/${hostId}/git`, { rootPath: root })).id;
      pendingInit.current = operation;
      const deadline = Date.now() + 65000;
      while (Date.now() < deadline) {
        const result = await api(`/operations/${operation}`);
        if (result.state === "completed") {
          pendingInit.current = null;
          await git.refetch();
          return;
        }
        if (["failed", "unknown"].includes(result.state)) {
          pendingInit.current = null;
          throw new Error(
            result.error?.message ?? translate("初始化未完成，请检查运行记录"),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(translate("初始化仍在执行，点击检查进度继续查看"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInitializing(false);
    }
  }
  return (
    <form
      className="field-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const listing = await api(
            `/hosts/${hostId}/directories?path=${encodeURIComponent(root)}${useGit ? "&git=true" : ""}`,
          );
          if (useGit && !listing.git?.hasCommit)
            throw new Error(
              translate("请先初始化 Git 并创建首次提交，或取消 Git 工作模式"),
            );
          const p = await api(`/workspaces/${workspace}/projects`, {
            name: listing.path.split("/").pop() || listing.path,
            hostId,
            rootPath: listing.path,
            workspaceMode: useGit ? "git-worktree" : "directory",
            baseRef: "HEAD",
            expectedVersion: projects.data?.items.find(
              (p: Item) => p.hostId === hostId && p.rootPath === listing.path,
            )?.version,
          });
          done(p);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy || initializing} className="project-fields">
        {hosts.data?.items.length > 1 && (
          <label>
            {translate("执行电脑")}
            <select
              value={hostId}
              onChange={(e) => {
                setHostId(e.target.value);
                setRoot("");
                pendingInit.current = null;
              }}
              required
            >
              <option value="">{translate("选择电脑")}</option>
              {hosts.data?.items.map((h: Item) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <DirectoryPicker
          api={api}
          hostId={hostId}
          value={root}
          onChange={(path) => {
            setRoot(path);
            pendingInit.current = null;
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={useGit}
            onChange={(e) => setUseGit(e.target.checked)}
          />
          {translate("Git 工作模式")}
        </label>
      </fieldset>
      {!useGit && (
        <p className="hint">
          {translate("直接在所选文件夹工作。多个成员共享文件，不提供文件锁。")}
        </p>
      )}
      {useGit && (
        <div className="git-options">
          <p className="hint">
            {translate(
              "每个成员使用独立 Git 工作副本；源目录未提交的改动不会自动复制。",
            )}
          </p>
          {!root ? (
            <p className="hint">{translate("先选择工作目录。")}</p>
          ) : git.isPending ? (
            <p className="hint">{translate("正在查找 Git 仓库…")}</p>
          ) : git.isError ? (
            <p className="error">
              {translateError((git.error as Error).message)}
            </p>
          ) : git.data?.git?.hasCommit ? (
            <p className="hint">
              {translate("已关联：")}
              <code>{git.data.git.repositoryRoot}</code>
            </p>
          ) : (
            <>
              <p className="hint">
                {git.data?.git
                  ? translate("此仓库还没有提交。")
                  : translate("未找到 Git 仓库。")}
                {translate(
                  "初始化会提交当前目录中未被 .gitignore 忽略的文件，不推送远端。",
                )}
              </p>
              <button
                type="button"
                disabled={busy || initializing}
                onClick={() => void initialize()}
              >
                {initializing
                  ? translate("正在初始化…")
                  : pendingInit.current
                    ? translate("检查进度")
                    : translate("初始化 Git 并创建首次提交")}
              </button>
            </>
          )}
        </div>
      )}
      {changedMode && (
        <p className="hint">
          {translate(
            "这会切换此目录所有成员的工作方式。请先停止成员；已有工作副本会保留，下次启动使用新会话。",
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {translateError(error)}
        </p>
      )}
      <button
        className="primary"
        disabled={
          busy ||
          initializing ||
          !root ||
          !hostId ||
          (useGit && !git.data?.git?.hasCommit)
        }
      >
        {busy
          ? translate("正在保存…")
          : existing
            ? translate("保存工作目录")
            : translate("使用此目录")}
      </button>
    </form>
  );
}
export function WorkspaceForm({
  api,
  done,
}: {
  api: Api;
  done: (id: string) => void;
}) {
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const created = useRef<string | null>(null);
  return (
    <form
      className="field-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const id = created.current ?? (await api("/workspaces", { name })).id;
          created.current = id;
          await api(`/workspaces/${id}/channels`, { name: translate("讨论") });
          done(id);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {translate("项目名称")}
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {translateError(error)}
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? translate("正在创建…") : translate("创建项目")}
      </button>
    </form>
  );
}
export function MemberForm({
  api,
  workspace,
  projects,
  projectId,
  channel,
  done,
}: {
  api: Api;
  workspace: string;
  projects: Item[];
  projectId: string;
  channel: string;
  done: (a: Item) => void;
}) {
  const [name, setName] = useState(""),
    [role, setRole] = useState(""),
    [driver, setDriver] = useState("codex-app-server"),
    [model, setModel] = useState("default"),
    [permission, setPermission] = useState("full-access"),
    [capabilities, setCapabilities] = useState(defaultCapabilities),
    [project, setProject] = useState(projectId || projects[0]?.id || ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [join, setJoin] = useState(false);
  const created = useRef<Item | null>(null);
  return (
    <form
      className="field-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const p = projects.find((x) => x.id === project);
          if (!p) throw new Error(translate("请先添加工作目录"));
          const a =
            created.current ??
            (await api(`/workspaces/${workspace}/agents`, {
              hostId: p.hostId,
              projectId: p.id,
              name,
              role,
              runtime: {
                driver,
                executableProfile:
                  driver === "codex-app-server"
                    ? "local-codex"
                    : "local-claude",
                model,
                permissionProfile: permission,
                settingsProfile: "project-reviewed",
              },
              capabilities,
            }));
          created.current = a;
          if (join && channel) {
            const c = await api(`/channels/${channel}/members`);
            await api(
              `/channels/${channel}/members`,
              {
                expectedVersion: c.version,
                agentIds: [...new Set([...c.agentIds, a.id])],
              },
              "PUT",
            );
          }
          done(a);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {translate("名称")}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
        />
      </label>
      <div className="field-pair">
        <label>
          Harness
          <select value={driver} onChange={(e) => setDriver(e.target.value)}>
            <option value="codex-app-server">Codex</option>
            <option value="claude-code-sdk">Claude Code</option>
          </select>
        </label>
        <label>
          {translate("模型")}
          <input
            value={model === "default" ? "" : model}
            onChange={(e) => setModel(e.target.value || "default")}
            placeholder={translate("使用 CLI 配置的模型")}
          />
        </label>
      </div>
      <label>
        {translate("工作目录")}
        <select
          value={project}
          onChange={(e) => setProject(e.target.value)}
          required
        >
          <option value="">{translate("选择目录")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.rootPath}
            </option>
          ))}
        </select>
      </label>
      <label>
        {translate("职责")}
        <textarea
          value={role}
          onChange={(e) => setRole(e.target.value)}
          required
          placeholder={translate("例如：实现功能、运行测试、审查改动")}
          rows={2}
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
      {channel && (
        <label>
          <input
            type="checkbox"
            checked={join}
            onChange={(e) => setJoin(e.target.checked)}
          />
          {translate("加入当前对话")}
        </label>
      )}

      {error && (
        <p role="alert" className="error">
          {translateError(error)}
        </p>
      )}
      <button className="primary" disabled={busy || !projects.length}>
        {busy
          ? translate("正在创建…")
          : created.current
            ? translate("重试加入对话")
            : translate("创建成员")}
      </button>
    </form>
  );
}
export function ChannelMembers({
  api,
  channel,
  agents,
  projects,
  done,
}: {
  api: Api;
  channel: string;
  agents: Item[];
  projects: Item[];
  done: () => void;
}) {
  const q = useQuery({
    queryKey: ["members", channel],
    queryFn: () => api(`/channels/${channel}/members`),
  });
  const [ids, setIds] = useState<string[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const loadedVersion = useRef<number | null>(null);
  useEffect(() => {
    if (q.data && loadedVersion.current === null) {
      setIds(q.data.agentIds);
      loadedVersion.current = q.data.version;
    }
  }, [q.data]);
  return (
    <form
      className="field-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api(
            `/channels/${channel}/members`,
            { expectedVersion: loadedVersion.current, agentIds: ids },
            "PUT",
          );
          done();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ParticipantChoices
        agents={agents}
        projects={projects}
        ids={ids}
        setIds={setIds}
        disabled={!q.data || busy}
      />
      <p className="hint">
        {translate(
          "取消勾选后不再接收此对话的新工作；已开始的一轮会继续完成。",
        )}
      </p>
      {(error || q.isError) && (
        <p className="error">
          {translateError(error || (q.error as Error).message)}
        </p>
      )}
      <button className="primary" disabled={busy || !q.data}>
        {translate("保存参与者")}
      </button>
    </form>
  );
}

function ParticipantChoices({
  agents,
  projects,
  ids,
  setIds,
  disabled = false,
}: {
  agents: Item[];
  projects: Item[];
  ids: string[];
  setIds: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="participant-choices" disabled={disabled}>
      <legend>{translate("参与成员")}</legend>
      {agents.map((a) => (
        <label key={a.id} className="participant-choice">
          <input
            type="checkbox"
            checked={ids.includes(a.id)}
            aria-label={a.name}
            onChange={(e) =>
              setIds(
                e.target.checked
                  ? [...ids, a.id]
                  : ids.filter((id) => id !== a.id),
              )
            }
          />
          <span>
            <strong>{a.name}</strong>
            <small>
              {a.runtime.driver === "codex-app-server"
                ? "Codex"
                : "Claude Code"}{" "}
            </small>
          </span>
        </label>
      ))}
      {!agents.length && (
        <p className="muted">
          {translate("尚无成员，可先创建对话，稍后添加成员。")}
        </p>
      )}
    </fieldset>
  );
}
export function ChannelForm({
  api,
  workspace,
  agents,
  projects,
  done,
}: {
  api: Api;
  workspace: string;
  agents: Item[];
  projects: Item[];
  done: (channel: Item) => void;
}) {
  const [name, setName] = useState(""),
    [ids, setIds] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="field-stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await done(
            await api(`/workspaces/${workspace}/channels`, {
              name: name.trim(),
              agentIds: ids,
            }),
          );
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {translate("对话名称")}
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
        />
      </label>
      <ParticipantChoices
        agents={agents}
        projects={projects}
        ids={ids}
        setIds={setIds}
        disabled={busy}
      />
      {error && (
        <p className="error" role="alert">
          {translateError(error)}
        </p>
      )}
      <button className="primary" disabled={busy || !name.trim()}>
        {busy ? translate("正在创建…") : translate("创建对话")}
      </button>
    </form>
  );
}
