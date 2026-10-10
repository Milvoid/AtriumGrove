import { translate } from "./i18n.js";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "./ui.js";
type Item = Record<string, any>;
export function ProjectTree({
  workspace,
  channel,
  api,
  select,
  createChat,
}: {
  workspace: Item;
  channel: string;
  api: (path: string) => Promise<any>;
  select: (workspaceId: string, channelId: string) => void;
  createChat: (workspaceId: string, projectId: string) => void;
}) {
  const folders = useQuery({
    queryKey: ["projects", workspace.id],
    queryFn: () => api(`/workspaces/${workspace.id}/projects?limit=200`),
  });
  const chats = useQuery({
    queryKey: ["project-chats", workspace.id],
    queryFn: () => api(`/workspaces/${workspace.id}/channels?limit=200`),
  });
  const [closed, setClosed] = useState<string[]>([]);
  return (
    <>
      {folders.data?.items.map((p: Item) => {
        const children =
          chats.data?.items.filter(
            (c: Item) => !c.archived && c.projectId === p.id,
          ) ?? [];
        if (!children.length) return null;
        const expanded = !closed.includes(p.id),
          name = p.rootPath.split("/").filter(Boolean).at(-1) || p.rootPath;
        return (
          <div className="project-tree" key={p.id}>
            <div className="project-tree-heading">
              <button
                className="project-tree-toggle"
                aria-label={translate(
                  expanded ? "收起 {name}" : "展开 {name}",
                  { name },
                )}
                aria-expanded={expanded}
                aria-controls={`project-chats-${p.id}`}
                onClick={() =>
                  setClosed((old) =>
                    expanded ? [...old, p.id] : old.filter((id) => id !== p.id),
                  )
                }
              >
                <Icon name="chevron" />
              </button>
              <button
                className="project-tree-name"
                title={p.rootPath}
                onClick={() => createChat(workspace.id, p.id)}
              >
                <Icon name="folder" />
                <span>{name}</span>
              </button>
              <button
                className="project-tree-add"
                aria-label={translate("在{v0}中新建对话", { v0: name })}
                onClick={() => createChat(workspace.id, p.id)}
              >
                <Icon name="plus" />
              </button>
            </div>
            <div
              className="project-tree-contents"
              data-expanded={expanded}
              inert={!expanded}
              aria-hidden={!expanded}
              id={`project-chats-${p.id}`}
            >
              <div className="project-tree-clip">
                <nav
                  className="project-chats"
                  aria-label={translate("{v0}的对话", { v0: name })}
                >
                  {children.map((c: Item) => (
                    <button
                      key={c.id}
                      title={c.name}
                      className={channel === c.id ? "active" : ""}
                      aria-current={channel === c.id ? "page" : undefined}
                      onClick={() => select(workspace.id, c.id)}
                    >
                      <span>{c.name}</span>
                    </button>
                  ))}
                </nav>
              </div>
            </div>
          </div>
        );
      })}
      {chats.data?.items
        .filter((c: Item) => !c.archived && !c.projectId)
        .map((c: Item) => (
          <button
            className={"unfiled-chat " + (channel === c.id ? "active" : "")}
            key={c.id}
            onClick={() => select(workspace.id, c.id)}
          >
            <Icon name="chat" />
            <span>{c.name}</span>
          </button>
        ))}
      {chats.isError && (
        <button onClick={() => void chats.refetch()}>
          {translate("对话读取失败，重试")}
        </button>
      )}
    </>
  );
}
