import { useEffect, useRef, useState, type ReactNode } from "react";
export function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 15) | 64;
  b[8] = (b[8]! & 63) | 128;
  const h = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const paths: Record<string, ReactNode> = {
  folder: (
    <path d="M3 8V6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6L13 7h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Zm0 0h8" />
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  members: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="16" cy="17" r="2" />
    </>
  ),
  chat: (
    <>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z" />
      <path d="M7 9h9M7 13h6" />
    </>
  ),
  tasks: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16M5.5 8h1M11.5 8h1M17.5 8h1" />
    </>
  ),
  runs: (
    <>
      <path d="M4 7h16M4 12h10M4 17h7" />
      <path d="m17 12 4 3-4 3Z" />
    </>
  ),
  approvals: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  memory: (
    <>
      <path d="M12 5v16M12 5C9 3 5 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1Z" />
    </>
  ),
  hosts: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="2" />
      <path d="M12 16v5M8 21h8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
  send: <path d="M12 20V4m-7 7 7-7 7 7" />,
  exit: (
    <>
      <path d="M9 4H4v16h5M10 12h11m-4-4 4 4-4 4" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  paperclip: <path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9" />,
  people: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m7 4 13 8-13 8Z" />,
};
export function Icon({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.chat}
    </svg>
  );
}
export function Brand() {
  return (
    <span className="brand">
      <b>Atrium Grove</b>
    </span>
  );
}
export function useDialog() {
  const [config, setConfig] = useState<{
    title: string;
    description?: string;
    input: boolean;
    resolve: (value: string | null) => void;
  } | null>(null);
  const [value, setValue] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (config) {
      ref.current?.showModal();
      ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    } else ref.current?.close();
  }, [config]);
  const finish = (v: string | null) => {
    config?.resolve(v);
    setConfig(null);
    setValue("");
  };
  const request = (title: string, description?: string, input = true) =>
    new Promise<string | null>((resolve) => {
      setValue("");
      setConfig({ title, description, input, resolve });
    });
  const dialog = (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        finish(null);
      }}
      aria-labelledby="dialog-title"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          finish(config?.input ? value : "yes");
        }}
      >
        <div className="dialog-heading">
          <h2 id="dialog-title">{config?.title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={() => finish(null)}
          >
            <Icon name="close" />
          </button>
        </div>
        {config?.description && <p className="muted">{config.description}</p>}
        {config?.input && (
          <label>
            {config.title}
            <input
              autoFocus
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}
        <div className="form-actions">
          <button type="button" onClick={() => finish(null)}>
            取消
          </button>
          <button className="primary">{config?.input ? "保存" : "确认"}</button>
        </div>
      </form>
    </dialog>
  );
  return { request, dialog };
}
