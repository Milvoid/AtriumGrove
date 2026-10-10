import type { Service } from "./service.js";
import type { BoundToolCaller } from "../../../spec/contracts/runtime.js";
import {
  validate,
  toolSchema,
  toolCapability,
} from "../../../packages/contracts/src/index.js";
import { invariant } from "../../../packages/domain/src/index.js";
import {
  uuid,
  now,
  type Row,
} from "../../../packages/persistence/src/index.js";
export function collaboration(
  s: Service,
  caller: BoundToolCaller,
  name: string,
  args: Row,
) {
  const run = s.scopeRun(caller),
    agent = s.store.entity("agents", caller.agentId),
    caps: string[] = JSON.parse(agent.capabilities_json);
  const channels = s.store
    .all("SELECT channel_id FROM channel_members WHERE agent_id=?", agent.id)
    .map((r) => r.channel_id);
  if (name === "tools/list")
    return Object.entries(toolSchema.$defs)
      .filter(([n]) => caps.includes(toolCapability[n]!))
      .map(([n, schema]) => ({
        name: n,
        description: `Atrium Grove ${n}: identity is bound to this launch.`,
        inputSchema: schema,
      }));
  invariant(
    caps.includes(toolCapability[name]!) ||
      (name === "task_transition" &&
        args.status === "done" &&
        caps.includes("task.review")),
    "CAPABILITY_DENIED",
    "Tool capability denied",
    403,
  );
  validate(name, args, true);
  if (args.channelId)
    invariant(
      channels.includes(args.channelId) ||
        s.store.entity("messages", run.primary_message_id).channel_id ===
          args.channelId,
      "CHANNEL_DENIED",
      "Caller is not a participant",
      403,
    );
  const command = () => {
    switch (name) {
      case "collab_context":
        return {
          agent: s.get("Agent", agent.id),
          run: s.get("Run", run.id),
          episode: s.get("Episode", run.episode_id),
          channelIds: channels,
          capabilities: caps,
        };
      case "collab_read": {
        let rows = s.store.all(
          "SELECT * FROM messages WHERE channel_id=? AND published_event_seq>?" +
            (args.threadId ? " AND thread_id=?" : "") +
            " ORDER BY published_event_seq LIMIT ?",
          args.channelId,
          BigInt(args.afterSeq ?? "0"),
          ...(args.threadId ? [args.threadId] : []),
          (args.limit ?? 50) + 1,
        );
        const more = rows.length > (args.limit ?? 50);
        if (more) rows.pop();
        return {
          messages: rows.map((r) => s.dto("Message", r)),
          nextCursor: more ? String(rows.at(-1)!.published_event_seq) : null,
          readReceiptId: null,
        };
      }
      case "collab_inbox":
        return {
          items: s.store
            .all(
              "SELECT * FROM deliveries WHERE agent_id=? AND state IN ('pending','reserved','sent') ORDER BY created_at LIMIT ?",
              agent.id,
              args.limit ?? 50,
            )
            .map((r) => s.dto("Delivery", r)),
        };
      case "collab_ack": {
        const accepted: string[] = [],
          rejected: string[] = [];
        for (const id of args.deliveryIds) {
          const d = s.store.entity("deliveries", id);
          if (
            d.agent_id !== agent.id ||
            !s.store.get(
              "SELECT 1 FROM read_contexts WHERE run_id=? AND delivery_id=?",
              run.id,
              id,
            )
          ) {
            rejected.push(id);
            continue;
          }
          s.store.run(
            "INSERT OR IGNORE INTO delivery_evidence VALUES (?,'agent_ack',?,NULL,?,?)",
            id,
            caller.launchId,
            run.context_digest,
            now(),
          );
          accepted.push(id);
        }
        return { accepted, rejected };
      }
      case "collab_post":
        return s.post(
          args.channelId,
          {
            ...args,
            blocks: [
              { type: "text", text: args.text },
              ...(args.artifactIds ?? []).map((id: string) => ({
                type: "artifact",
                artifactId: id,
              })),
            ],
            recipientAgentIds: args.recipients,
            clientMessageId: uuid(),
          },
          agent.id,
          caller,
        );
      case "task_list":
        return s.list(
          "Task",
          caller.workspaceId,
          {
            ...(args.channelId ? { channel_id: args.channelId } : {}),
            ...(args.status ? { status: args.status } : {}),
          },
          args.cursor,
          args.limit ?? 50,
        );
      case "task_get":
        s.scope("tasks", args.taskId, caller.workspaceId);
        return s.get("Task", args.taskId);
      case "task_create":
        return s.createTask(
          caller.workspaceId,
          { ...args, dependencyTaskIds: args.dependencies ?? [] },
          agent.id,
        );
      case "task_claim":
        s.scope("tasks", args.taskId, caller.workspaceId);
        return s.claim(
          args.taskId,
          agent.id,
          args.expectedVersion,
          agent.id,
          caller,
        );
      case "task_transition":
        s.scope("tasks", args.taskId, caller.workspaceId);
        return s.transition(args.taskId, args, agent.id);
      case "memory_propose":
        return s.memory(caller.workspaceId, args, agent.id);
      case "artifact_read": {
        const { artifact, bytes } = s.artifacts.read(
          args.artifactId,
          caller.workspaceId,
          run.id,
        );
        if (artifact.mime_type.startsWith("image/"))
          return {
            content: [
              {
                type: "image",
                data: bytes.toString("base64"),
                mimeType: artifact.mime_type,
              },
            ],
          };
        return {
          content: [
            { type: "text", text: bytes.toString("utf8").slice(0, 524288) },
          ],
        };
      }
      default:
        throw new Error("Tool handled by Host: " + name);
    }
  };
  const result = args.requestKey
    ? s.mutate(agent.id, "tool:" + name, args.requestKey, args, command)
    : command();
  return name === "artifact_read"
    ? result
    : { content: [{ type: "text", text: JSON.stringify(result) }] };
}
