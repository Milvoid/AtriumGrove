import { computerUseAllowed } from "../../../packages/runtime-common/src/permissions.js";
import { validateJson } from "../../../packages/contracts/src/index.js";
import type { Service } from "./service.js";
import {
  uuid,
  now,
  type Row,
} from "../../../packages/persistence/src/index.js";
import {
  invariant,
  TERMINAL_RUNS,
} from "../../../packages/domain/src/index.js";

export function execute(
  s: Service,
  op: string,
  p: Row,
  b: Row = {},
  q: Row = {},
): any {
  const db = s.store,
    owner = s.auth.owner,
    ws = p.workspaceId;
  const list = (type: string, workspace = ws, filter: Row = {}) =>
    s.list(type, workspace ?? "", filter, q.cursor, Number(q.limit ?? 50));
  switch (op) {
    case "health":
      return { status: "ok", version: "0.1.0" };
    case "listWorkspaces":
      return list("Workspace", "");
    case "createWorkspace":
      return s.createWorkspace(b.name);
    case "workspaceSnapshot":
      return s.snapshot(ws);
    case "workspaceControl": {
      const row = s.workspace(ws);
      s.version(row, b.expectedVersion);
      db.run(
        "UPDATE workspaces SET state=?,version=version+1 WHERE id=?",
        b.action === "pause" ? "paused" : "active",
        ws,
      );
      return s.updated("Workspace", ws, ws, owner);
    }
    case "listHosts":
      return list("Host", "");
    case "hostInventory": {
      const h = db.entity("hosts", p.hostId);
      return { hostId: h.id, entries: JSON.parse(h.inventory_json) };
    }
    case "probeHost":
      db.entity("hosts", p.hostId);
      return s.operation(p.hostId, "host.probe", {});
    case "listProjects":
      return list("Project");
    case "initializeGit":
      db.entity("hosts", p.hostId);
      invariant(
        s.connectedHosts.has(p.hostId),
        "HOST_OFFLINE",
        "请先连接执行电脑",
        409,
      );
      return s.operation(p.hostId, "project.git.initialize", {
        rootPath: b.rootPath,
      });
    case "createProject": {
      s.workspace(ws);
      db.entity("hosts", b.hostId);
      const mode = b.workspaceMode ?? "directory";
      const existing = db.get(
        "SELECT * FROM projects WHERE workspace_id=? AND host_id=? AND root_path=?",
        ws,
        b.hostId,
        b.rootPath,
      );
      const id = existing?.id ?? uuid();
      if (
        existing &&
        (existing.workspace_mode !== mode ||
          existing.base_ref !== (b.baseRef ?? "HEAD"))
      ) {
        s.version(existing, b.expectedVersion);
        invariant(
          !db.get(
            "SELECT 1 FROM agents a JOIN agent_sessions se ON se.agent_id=a.id LEFT JOIN channels c ON c.id=se.channel_id WHERE COALESCE(c.project_id,a.project_id)=? AND se.state NOT IN ('closed','failed')",
            id,
          ),
          "PROJECT_BUSY",
          "请先在各对话中取消此目录成员的参与，并等待当前运行结束，再切换工作方式",
          409,
        );
        db.run(
          "UPDATE projects SET workspace_mode=?,base_ref=?,version=version+1 WHERE id=?",
          mode,
          b.baseRef ?? "HEAD",
          id,
        );
      } else if (!existing) {
        db.run(
          "INSERT INTO projects(id,workspace_id,host_id,name,root_path,base_ref,workspace_mode,version) VALUES (?,?,?,?,?,?,?,1)",
          id,
          ws,
          b.hostId,
          b.name,
          b.rootPath,
          b.baseRef ?? "HEAD",
          mode,
        );
      }
      s.operation(
        b.hostId,
        "project.verify",
        {
          projectId: id,
          rootPath: b.rootPath,
          baseRef: b.baseRef ?? "HEAD",
          workspaceMode: mode,
        },
        ws,
      );
      return s.get("Project", id);
    }
    case "listAgents":
      return list("Agent");
    case "createAgent":
      return s.createAgent(ws, b);
    case "getAgent":
      return s.get("Agent", p.agentId);
    case "patchAgent": {
      const a = db.entity("agents", p.agentId);
      invariant(!a.deleted_at, "AGENT_DELETED", "该成员已删除", 404);
      s.version(a, b.expectedVersion);
      invariant(
        !db.get(
          "SELECT 1 FROM runs WHERE agent_id=? AND state NOT IN ('completed','failed','interrupted')",
          a.id,
        ),
        "AGENT_BUSY",
        "成员正在执行，请等待本轮完成后保存配置",
        409,
      );
      invariant(
        !db.get(
          "SELECT 1 FROM agent_sessions WHERE agent_id=? AND state NOT IN ('ready','closed','failed')",
          a.id,
        ),
        "SESSION_ACTIVE",
        "会话正在连接或状态异常，请等待连接完成或先处理运行异常",
        409,
      );
      const runtime = b.runtime ?? JSON.parse(a.runtime_json);
      const capabilities = b.capabilities ?? JSON.parse(a.capabilities_json);
      invariant(
        !capabilities.includes("desktop.request") ||
          computerUseAllowed(runtime.permissionProfile, capabilities),
        "COMPUTER_PERMISSION_MODE",
        "Computer Use 仅支持 Auto Approve 或 Full Access",
        400,
      );
      s.closeIdleSession(a);
      db.run(
        "UPDATE agents SET name=?,role_text=?,runtime_json=?,capabilities_json=?,version=version+1 WHERE id=?",
        b.name ?? a.name,
        b.role ?? a.role_text,
        JSON.stringify(b.runtime ?? JSON.parse(a.runtime_json)),
        JSON.stringify(b.capabilities ?? JSON.parse(a.capabilities_json)),
        a.id,
      );
      return s.updated("Agent", a.id, a.workspace_id, owner);
    }
    case "deleteAgent": {
      const a = db.entity("agents", p.agentId);
      invariant(!a.deleted_at, "AGENT_DELETED", "该成员已删除", 404);
      s.version(a, b.expectedVersion);
      invariant(
        !db.get(
          "SELECT 1 FROM runs WHERE agent_id=? AND state NOT IN ('completed','failed','interrupted')",
          a.id,
        ),
        "AGENT_BUSY",
        "成员正在执行，请先停止运行或等待完成后再删除",
        409,
      );
      invariant(
        !db.get(
          "SELECT 1 FROM agent_sessions WHERE agent_id=? AND state NOT IN ('ready','closed','failed')",
          a.id,
        ),
        "SESSION_ACTIVE",
        "成员会话正在连接或清理，请等待完成后再删除",
        409,
      );
      invariant(
        !db.get(
          "SELECT 1 FROM tasks WHERE (assignee_agent_id=? OR reviewer_agent_id=?) AND status NOT IN ('done','cancelled')",
          a.id,
          a.id,
        ),
        "AGENT_HAS_TASKS",
        "成员仍负责未完成任务，请先转交、完成或取消任务后再删除",
        409,
      );
      s.closeIdleSession(a);
      const channels = db.all(
        "SELECT channel_id FROM channel_members WHERE agent_id=?",
        a.id,
      );
      db.run("DELETE FROM channel_members WHERE agent_id=?", a.id);
      for (const c of channels) {
        db.run(
          "UPDATE channels SET version=version+1 WHERE id=?",
          c.channel_id,
        );
        s.updated("Channel", c.channel_id, a.workspace_id, owner);
      }
      for (const d of db.all(
        "SELECT id FROM deliveries WHERE agent_id=? AND state='pending'",
        a.id,
      )) {
        db.run(
          "UPDATE deliveries SET state='cancelled',error_code='AGENT_DELETED' WHERE id=?",
          d.id,
        );
        s.updated("Delivery", d.id, a.workspace_id, owner);
      }
      db.run(
        "UPDATE response_expectations SET state='cancelled' WHERE state='pending' AND (requester_agent_id=? OR responder_agent_id=?)",
        a.id,
        a.id,
      );
      // Preserve historical foreign keys and names; release the unique preset name.
      db.run(
        "UPDATE agents SET deleted_at=?,deleted_name=name,name=?,desired_state='stopped',capabilities_json='[]',version=version+1 WHERE id=?",
        now(),
        `deleted:${a.id}`,
        a.id,
      );
      return s.updated("Agent", a.id, a.workspace_id, owner);
    }
    case "controlAgent": {
      const a = db.entity("agents", p.agentId);
      invariant(!a.deleted_at, "AGENT_DELETED", "该成员已删除", 404);
      s.version(a, b.expectedVersion);
      invariant(
        !["start", "resume", "pause"].includes(b.action),
        "USE_CHANNEL_PARTICIPATION",
        "请在对话中选择参与成员；成员会在收到消息时自动执行",
        409,
      );
      db.run(
        "UPDATE agents SET desired_state='stopped',version=version+1 WHERE id=?",
        a.id,
      );
      const session = db.get(
        "SELECT * FROM agent_sessions WHERE agent_id=? AND state NOT IN ('closed','failed')",
        a.id,
      );
      s.updated("Agent", a.id, a.workspace_id, owner);
      return s.operation(
        a.host_id,
        "runtime.close",
        {
          agentId: a.id,
          reason: b.action === "reset_session" ? "reset" : "shutdown",
          reset: b.action === "reset_session",
        },
        a.workspace_id,
        session?.launch_id,
      );
    }
    case "listAgentSessions":
      db.entity("agents", p.agentId);
      return list("Session", "", { agent_id: p.agentId });
    case "listAgentDeliveries":
      db.entity("agents", p.agentId);
      return list("Delivery", "", { agent_id: p.agentId });
    case "listChannels":
      return list("Channel");
    case "startConversation": {
      const title =
        b.message.blocks
          .find((block: Row) => block.type === "text")
          ?.text.trim()
          .replace(/\s+/g, " ")
          .slice(0, 64) || "附件对话";
      let name = title,
        suffix = 2;
      while (
        db.get(
          "SELECT 1 FROM channels WHERE workspace_id=? AND name=?",
          ws,
          name,
        )
      )
        name = `${title} (${suffix++})`;
      const channel = s.createChannel(ws, name, "", b.agentIds, b.projectId);
      return s.post(channel.id, b.message);
    }
    case "createChannel":
      return s.createChannel(
        ws,
        b.name,
        b.topic,
        b.agentIds ?? [],
        b.projectId ?? null,
      );
    case "setChannelMembers": {
      return s.setChannelMembers(p.channelId, b.agentIds, b.expectedVersion);
    }
    case "listThreads": {
      const c = db.entity("channels", p.channelId);
      return s.list(
        "Thread",
        "",
        { channel_id: c.id },
        q.cursor,
        Number(q.limit ?? 50),
      );
    }
    case "createThread": {
      const c = db.entity("channels", p.channelId),
        id = uuid();
      db.run(
        "INSERT INTO threads VALUES (?,?,?,'open',?)",
        id,
        c.id,
        b.title,
        now(),
      );
      return s.updated("Thread", id, c.workspace_id, owner);
    }
    case "listMessages": {
      const c = db.entity("channels", p.channelId);
      return s.list(
        "Message",
        c.workspace_id,
        { channel_id: c.id, ...(q.threadId ? { thread_id: q.threadId } : {}) },
        q.cursor,
        Number(q.limit ?? 50),
      );
    }
    case "postMessage":
      return s.post(p.channelId, b);
    case "getEpisode":
      return s.get("Episode", p.episodeId);
    case "controlEpisode": {
      const e = db.entity("episodes", p.episodeId);
      s.version(e, b.expectedVersion);
      const budget = JSON.parse(e.budget_json);
      budget.maxNativeTurns += b.additionalTurns ?? 0;
      invariant(
        budget.maxNativeTurns <= 1000,
        "BUDGET_LIMIT",
        "Budget exceeds maximum",
      );
      db.run(
        "UPDATE episodes SET state=?,budget_json=?,max_native_turns=?,version=version+1 WHERE id=?",
        b.action === "pause"
          ? "paused_human"
          : b.action === "close"
            ? "complete"
            : "open",
        JSON.stringify(budget),
        budget.maxNativeTurns,
        e.id,
      );
      return s.updated("Episode", e.id, e.workspace_id, owner);
    }
    case "listTasks":
      return list("Task");
    case "createTask":
      return s.createTask(ws, b, owner);
    case "getTask":
      return s.get("Task", p.taskId);
    case "claimTask":
      return s.claim(p.taskId, b.agentId, b.expectedVersion, owner);
    case "transitionTask":
      return s.transition(p.taskId, b, owner);
    case "listRuns": {
      s.workspace(ws);
      const filter = q.channelId ? { channelId: q.channelId } : {};
      if (q.channelId)
        invariant(
          db.entity("channels", q.channelId).workspace_id === ws,
          "CHANNEL_SCOPE",
          "Conversation belongs to another project",
        );
      const limit = Math.min(200, Number(q.limit ?? 50));
      const rows = db.all(
        "SELECT r.* FROM runs r JOIN agents a ON a.id=r.agent_id JOIN messages m ON m.id=r.primary_message_id WHERE a.workspace_id=? AND (? IS NULL OR m.channel_id=?) AND r.id>? ORDER BY r.id LIMIT ?",
        ws,
        q.channelId ?? null,
        q.channelId ?? null,
        q.cursor ? s.cursor.decode(q.cursor, ws, "Run", filter).lastId : "",
        limit + 1,
      );
      const more = rows.length > limit;
      if (more) rows.pop();
      const last = rows.at(-1);
      return {
        items: rows.map((r) => s.dto("Run", r)),
        nextCursor:
          more && last
            ? s.cursor.encode(ws, "Run", filter, last.id, last.id)
            : null,
      };
    }

    case "getRun":
      return s.get("Run", p.runId);
    case "getRunEvents": {
      const run = db.entity("runs", p.runId);
      const after = q.cursor
        ? s.cursor.decode(q.cursor, run.id, "Trace", {}).lastSortKey
        : "0";
      const limit = Math.min(200, Number(q.limit ?? 50));
      const rows = db.all(
        "SELECT * FROM runtime_events WHERE run_id=? AND producer_seq>? ORDER BY producer_seq LIMIT ?",
        run.id,
        Number(after),
        limit + 1,
      );
      const more = rows.length > limit;
      if (more) rows.pop();
      return {
        items: rows.map((r) => ({
          id: r.id,
          launchId: r.launch_id,
          producerSeq: r.producer_seq,
          agentId: r.agent_id,
          sessionId: r.session_id,
          runId: r.run_id,
          nativeTurnId: r.native_turn_id,
          kind: r.kind,
          lane: JSON.parse(r.lane_json),
          occurredAt: r.occurred_at,
          payload: JSON.parse(r.payload_json),
        })),
        nextCursor: more
          ? s.cursor.encode(
              run.id,
              "Trace",
              {},
              String(rows.at(-1)!.producer_seq),
              rows.at(-1)!.id,
            )
          : null,
      };
    }
    case "controlRun": {
      const r = db.entity("runs", p.runId),
        a = db.entity("agents", r.agent_id);
      invariant(
        b.action === "steer"
          ? typeof b.text === "string" && b.text.trim()
          : b.text === undefined,
        "INVALID_CONTROL",
        "Only steer accepts nonempty text",
        400,
      );
      if (TERMINAL_RUNS.includes(r.state) && b.action === "interrupt") {
        const id = uuid();
        db.run(
          "INSERT INTO operations(id,state,result_json,created_at,workspace_id) VALUES (?,'completed',?,?,?)",
          id,
          JSON.stringify({ alreadyTerminal: true }),
          now(),
          a.workspace_id,
        );
        return s.get("Operation", id);
      }
      return s.operation(
        a.host_id,
        "runtime." + b.action,
        { runId: r.id, text: b.text, clientMessageId: b.clientMessageId },
        a.workspace_id,
        r.launch_id,
        r.id,
      );
    }
    case "listApprovals":
      return list("Approval");
    case "resolveApproval": {
      const a = db.entity("approvals", p.approvalId),
        run = db.entity("runs", a.run_id),
        agent = db.entity("agents", a.agent_id);
      invariant(!a.deleted_at, "AGENT_DELETED", "该成员已删除", 404);
      s.version(a, b.expectedVersion);
      invariant(
        a.state === "pending" &&
          (!a.expires_at || a.expires_at > now()) &&
          run.launch_id === a.launch_id &&
          !TERMINAL_RUNS.includes(run.state),
        "STALE_APPROVAL",
        "Native request is no longer active",
        409,
      );
      invariant(
        a.argument_hash === b.argumentHash,
        "STALE_APPROVAL",
        "Approval parameters changed",
        409,
      );
      invariant(
        JSON.parse(a.allowed_actions_json).includes(b.action),
        "INVALID_DECISION",
        "Action not offered",
      );
      if (b.action === "approve")
        validateJson(JSON.parse(a.input_schema_json), b.content ?? {});
      db.run(
        "UPDATE approvals SET state=?,result_json=?,resolved_by=?,version=version+1 WHERE id=?",
        b.action === "approve"
          ? "approved"
          : b.action === "deny"
            ? "denied"
            : "cancelled",
        JSON.stringify(b),
        owner,
        a.id,
      );
      s.operation(
        agent.host_id,
        "approval.respond",
        { ...b, approvalId: a.id },
        a.workspace_id,
        a.launch_id,
        a.run_id,
      );
      return s.updated("Approval", a.id, a.workspace_id, owner);
    }
    case "listArtifacts":
      return list("Artifact");
    case "artifactMetadata":
      return s.get("Artifact", p.artifactId);
    case "listMemory":
      return list("Memory");
    case "proposeMemory":
      return s.memory(ws, b, owner);
    case "decideMemory": {
      const m = db.entity("memories", p.memoryId);
      s.version(m, b.expectedVersion);
      invariant(
        b.action === "accept"
          ? m.status === "proposed"
          : m.status === "accepted",
        "INVALID_TRANSITION",
        "Memory state changed",
      );
      db.run(
        "UPDATE memories SET status=?,version=version+1 WHERE id=?",
        b.action === "accept" ? "accepted" : "superseded",
        m.id,
      );
      return s.updated("Memory", m.id, m.workspace_id, owner);
    }
    case "desktopStatus": {
      db.entity("hosts", p.hostId);
      const r = db.get(
        "SELECT * FROM resource_projections WHERE host_id=?",
        p.hostId,
      );
      return r
        ? {
            hostId: r.host_id,
            provider: r.provider,
            qualified: !!r.qualified,
            state: r.state,
            leaseEpoch: r.lease_epoch,
            ownerAgentId: r.owner_run_id
              ? (db.get("SELECT agent_id FROM runs WHERE id=?", r.owner_run_id)
                  ?.agent_id ?? null)
              : null,
            ownerRunId: r.owner_run_id,
            inFlightCalls: r.in_flight_calls,
            diagnostic: r.diagnostic,
          }
        : {
            hostId: p.hostId,
            provider: "disabled",
            qualified: false,
            state: "unavailable",
            leaseEpoch: 0,
            ownerAgentId: null,
            ownerRunId: null,
            inFlightCalls: 0,
            diagnostic: "Provider not qualified",
          };
    }
    case "desktopControl":
      db.entity("hosts", p.hostId);
      return s.operation(p.hostId, "desktop." + b.action, { reason: b.reason });
    case "getOperation":
      return s.get("Operation", p.operationId);
    case "metrics": {
      s.workspace(ws);
      return {
        activeRuns: db.get(
          "SELECT count(*) n FROM runs r JOIN agents a ON a.id=r.agent_id WHERE a.workspace_id=? AND r.state NOT IN ('completed','failed','interrupted')",
          ws,
        )!.n,
        pendingDeliveries: db.get(
          "SELECT count(*) n FROM deliveries d JOIN agents a ON a.id=d.agent_id WHERE a.workspace_id=? AND d.state='pending'",
          ws,
        )!.n,
        unknownRuns: db.get(
          "SELECT count(*) n FROM runs r JOIN agents a ON a.id=r.agent_id WHERE a.workspace_id=? AND r.state='unknown'",
          ws,
        )!.n,
        pendingApprovals: db.get(
          "SELECT count(*) n FROM approvals WHERE workspace_id=? AND state='pending'",
          ws,
        )!.n,
        hostLagMs: (() => {
          const hosts = db.all(
            "SELECT DISTINCT h.last_seen_at FROM hosts h JOIN agents a ON a.host_id=h.id WHERE a.workspace_id=?",
            ws,
          );
          return hosts.length && hosts.every((h) => h.last_seen_at)
            ? Math.max(
                ...hosts.map((h) =>
                  Math.max(0, Date.now() - Date.parse(h.last_seen_at)),
                ),
              )
            : null;
        })(),
        desktopQuarantines: db.get(
          "SELECT count(*) n FROM resource_projections WHERE state='quarantined'",
        )!.n,
      };
    }
    default:
      throw new Error(`Operation not implemented: ${op}`);
  }
}
