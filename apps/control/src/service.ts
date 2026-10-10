import { computerUseAllowed } from "../../../packages/runtime-common/src/permissions.js";
import {
  Store,
  Auth,
  Cursor,
  uuid,
  now,
  canonical,
  sha,
  type Row,
} from "../../../packages/persistence/src/index.js";
import { Artifacts } from "../../../packages/artifacts/src/index.js";
import {
  invariant,
  DomainError,
  ACTIVE_RUNS,
  TERMINAL_RUNS,
  assertMessageLimits,
  hasCycle,
  canTransitionTask,
} from "../../../packages/domain/src/index.js";
import {
  validate,
  toolSchema,
  toolCapability,
} from "../../../packages/contracts/src/index.js";
import type { BoundToolCaller } from "../../../spec/contracts/runtime.js";
import { join } from "node:path";

const defaultBudget = {
  maxNativeTurns: 32,
  maxDepth: 8,
  maxAgentFanout: 3,
  wallTimeSec: 3600,
  softTokenLimit: null,
};
const json = (v: string | null | undefined, fallback: any = null) =>
  v ? JSON.parse(v) : fallback;
const tableFor: Record<string, string> = {
  Workspace: "workspaces",
  Host: "hosts",
  Project: "projects",
  Agent: "agents",
  Session: "agent_sessions",
  Channel: "channels",
  Thread: "threads",
  Message: "messages",
  Episode: "episodes",
  Task: "tasks",
  Run: "runs",
  Delivery: "deliveries",
  Approval: "approvals",
  Artifact: "artifacts",
  Memory: "memories",
  Operation: "operations",
};
export class Service {
  readonly auth: Auth;
  readonly cursor: Cursor;
  readonly artifacts: Artifacts;
  readonly controllerEpoch = uuid();
  readonly connectedHosts = new Set<string>();
  onCommit: () => void = () => {};
  constructor(
    readonly store: Store,
    readonly stateDir: string,
  ) {
    this.auth = new Auth(store);
    this.cursor = new Cursor(store.meta("cursor_secret")!);
    this.artifacts = new Artifacts(join(stateDir, "artifacts"), store);
  }
  actor(id: string) {
    const r = this.store.entity("principals", id);
    return { kind: r.kind, id: r.id, displayName: r.display_name };
  }
  dto(type: string, r: Row): any {
    const p = (name: string, fallback: any = null) => json(r[name], fallback);
    switch (type) {
      case "Workspace":
        return {
          id: r.id,
          name: r.name,
          state: r.state,
          version: r.version,
          createdAt: r.created_at,
        };
      case "Host":
        return {
          id: r.id,
          name: r.name,
          platform: r.platform,
          architecture: r.architecture,
          state: r.state,
          lastSeenAt: r.last_seen_at,
          bootId: r.boot_id,
          capabilities: p("capabilities_json", []),
        };
      case "Project":
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          hostId: r.host_id,
          name: r.name,
          rootPath: r.root_path,
          baseRef: r.base_ref,
          workspaceMode: r.workspace_mode,
          version: r.version,
        };
      case "Agent":
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          hostId: r.host_id,
          projectId: r.project_id,
          name: r.deleted_name ?? r.name,
          role: r.role_text,
          runtime: p("runtime_json"),
          desiredState: r.desired_state,
          observedState: r.observed_state,
          capabilities: p("capabilities_json", []),
          version: r.version,
        };
      case "Channel":
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          name: r.name,
          topic: r.topic,
          version: r.version,
          archived: !!r.archived,
          projectId: r.project_id ?? null,
        };
      case "Thread":
        return {
          id: r.id,
          channelId: r.channel_id,
          title: r.title,
          state: r.state,
          createdAt: r.created_at,
        };
      case "Session":
        return {
          id: r.id,
          agentId: r.agent_id,
          driver: r.driver,
          nativeSessionId: r.native_session_id,
          launchId: r.launch_id,
          generation: r.generation,
          state: r.state,
          workspacePath: r.workspace_path,
          channelId: r.channel_id ?? null,
          createdAt: r.created_at,
        };
      case "Message":
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          channelId: r.channel_id,
          threadId: r.thread_id,
          replyToMessageId: r.reply_to_message_id,
          actor: this.actor(r.actor_id),
          blocks: p("blocks_json", []),
          recipientAgentIds: this.store
            .all(
              "SELECT agent_id FROM message_recipients WHERE message_id=?",
              r.id,
            )
            .map((x) => x.agent_id),
          requestResponse: !!r.request_response,
          kind: r.kind,
          episodeId: r.episode_id,
          runId: r.run_id,
          seq: this.store.seq(
            "SELECT published_event_seq FROM messages WHERE id=?",
            r.id,
          ),
          createdAt: r.created_at,
        };
      case "Episode":
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          rootMessageId: r.root_message_id,
          state: r.state,
          budget: p("budget_json"),
          nativeTurnsReserved: r.native_turns_reserved,
          version: r.version,
          createdAt: r.created_at,
        };
      case "Task":
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          channelId: r.channel_id,
          threadId: r.thread_id,
          sourceMessageId: r.source_message_id,
          title: r.title,
          description: r.description,
          acceptanceCriteria: p("acceptance_json", []),
          status: r.status,
          assigneeAgentId: r.assignee_agent_id,
          reviewerAgentId: r.reviewer_agent_id,
          leaseEpoch: r.lease_epoch,
          version: r.version,
          artifactIds: this.store
            .all("SELECT artifact_id FROM task_artifacts WHERE task_id=?", r.id)
            .map((x) => x.artifact_id),
          dependencyTaskIds: this.store
            .all(
              "SELECT depends_on_id FROM task_dependencies WHERE task_id=?",
              r.id,
            )
            .map((x) => x.depends_on_id),
        };
      case "Run":
        return {
          id: r.id,
          agentId: r.agent_id,
          sessionId: r.session_id,
          episodeId: r.episode_id,
          taskId: r.task_id,
          primaryMessageId: r.primary_message_id,
          nativeTurnId: r.native_turn_id,
          state: r.state,
          nativeOutcome: r.native_outcome,
          launchId: r.launch_id,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          errorCode: r.error_code,
          contextDigest: r.context_digest,
          contextArtifactId: r.context_artifact_id,
          finalMessageId: r.final_message_id,
        };
      case "Delivery":
        return {
          id: r.id,
          agentId: r.agent_id,
          messageId: r.message_id,
          runId: r.run_id,
          state: r.state,
          evidence: [
            ...new Set(
              this.store
                .all(
                  "SELECT kind FROM delivery_evidence WHERE delivery_id=?",
                  r.id,
                )
                .map((x) => x.kind),
            ),
          ],
          attempt: r.attempt,
          errorCode: r.error_code,
        };
      case "Approval":
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          agentId: r.agent_id,
          runId: r.run_id,
          launchId: r.launch_id,
          source: r.source,
          kind: r.kind,
          state: r.state,
          title: r.title,
          inputSchema: p("input_schema_json", {}),
          display: p("display_json", {}),
          allowedActions: p("allowed_actions_json", []),
          argumentHash: r.argument_hash,
          version: r.version,
          expiresAt: r.expires_at,
        };
      case "Artifact":
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          kind: r.kind,
          filename: r.filename,
          mimeType: r.mime_type,
          sizeBytes: r.size_bytes,
          sha256: r.sha256,
          creator: this.actor(r.creator_id),
          createdAt: r.created_at,
          retentionClass: r.retention_class,
        };
      case "Memory":
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          scope: r.scope,
          ownerId: r.owner_id,
          title: r.title,
          body: r.body,
          sourceMessageIds: p("sources_json", []),
          status: r.status,
          version: r.version,
        };
      case "Operation":
        return {
          id: r.id,
          state: r.state,
          ...(r.result_json ? { result: p("result_json") } : {}),
          error: p("error_json"),
        };
      default:
        throw new Error(`Unknown DTO ${type}`);
    }
  }
  get(type: string, id: string) {
    return this.dto(type, this.store.entity(tableFor[type]!, id));
  }
  event(
    workspaceId: string,
    type: string,
    field: string,
    value: any,
    actorId = this.auth.system,
    source?: string,
  ) {
    const id = uuid();
    const result = this.store.run(
      "INSERT INTO events(event_id,workspace_id,event_type,actor_id,entity_id,payload_json,occurred_at,source_key) VALUES (?,?,?,?,?,?,?,?)",
      id,
      workspaceId,
      type,
      actorId,
      value.id ?? null,
      JSON.stringify({ [field]: value }),
      now(),
      source ?? null,
    );
    return String(result.lastInsertRowid);
  }
  updated(
    type: string,
    id: string,
    ws: string,
    actor = this.auth.system,
    eventType?: string,
  ) {
    const dto = this.get(type, id);
    this.event(
      ws,
      eventType ?? type.toLowerCase() + ".updated",
      type.toLowerCase(),
      dto,
      actor,
    );
    return dto;
  }
  mutate(
    actor: string,
    route: string,
    key: string,
    body: unknown,
    fn: () => any,
  ) {
    invariant(
      key && key.length <= 160,
      "IDEMPOTENCY_REQUIRED",
      "Idempotency-Key required",
      400,
    );
    const result = this.store.tx(() => {
      const hash = sha(canonical(body ?? {})),
        old = this.store.get(
          "SELECT * FROM idempotency_keys WHERE principal_id=? AND route_key=? AND idempotency_key=?",
          actor,
          route,
          key,
        );
      if (old) {
        invariant(
          old.request_hash === hash,
          "IDEMPOTENCY_CONFLICT",
          "Key reused with different body",
          409,
        );
        return json(old.response_json);
      }
      const response = fn();
      this.store.run(
        "INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?,?)",
        actor,
        route,
        key,
        hash,
        200,
        JSON.stringify(response),
        now(),
      );
      return response;
    });
    this.onCommit();
    return result;
  }
  workspace(id: string) {
    return this.store.entity("workspaces", id);
  }
  scope(table: string, id: string, ws: string) {
    const r = this.store.entity(table, id);
    invariant(
      table !== "agents" || !r.deleted_at,
      "AGENT_DELETED",
      "该成员已删除",
      404,
    );
    invariant(
      r.workspace_id === ws,
      "SCOPE_DENIED",
      "Resource belongs to another workspace",
      403,
    );
    return r;
  }
  version(row: Row, expected: number) {
    invariant(
      row.version === expected,
      "VERSION_CONFLICT",
      "Resource version changed",
      409,
    );
  }
  operation(
    hostId: string,
    kind: string,
    payload: Row,
    ws: string | null = null,
    launchId?: string,
    runId?: string,
  ) {
    const id = uuid();
    const envelope = {
      schemaVersion: 1,
      commandId: id,
      controllerEpoch: this.controllerEpoch,
      hostId,
      issuedAt: now(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      kind,
      launchId,
      runId,
      payload,
      payloadHash: sha(canonical(payload)),
    };
    this.store.run(
      "INSERT INTO operations(id,state,created_at,workspace_id) VALUES (?,'accepted',?,?)",
      id,
      now(),
      ws,
    );
    this.store.run(
      "INSERT INTO host_commands(id,host_id,controller_epoch,kind,payload_json,state,created_at) VALUES (?,?,?,?,?,'pending',?)",
      id,
      hostId,
      this.controllerEpoch,
      kind,
      JSON.stringify(envelope),
      now(),
    );
    if (ws) this.updated("Operation", id, ws);
    return this.get("Operation", id);
  }
  createWorkspace(name: string) {
    const id = uuid();
    this.store.run(
      "INSERT INTO workspaces(id,name,owner_id,state,created_at) VALUES (?,?,?,'active',?)",
      id,
      name,
      this.auth.owner,
      now(),
    );
    this.store.run("INSERT INTO retention_frontiers VALUES (?,0)", id);
    return this.updated("Workspace", id, id);
  }
  createChannel(
    ws: string,
    name: string,
    topic = "",
    agentIds: string[] = [],
    projectId: string | null = null,
  ) {
    this.workspace(ws);
    if (projectId) this.scope("projects", projectId, ws);
    for (const id of agentIds) {
      this.scope("agents", id, ws);
      if (projectId)
        invariant(
          this.store.entity("agents", id).host_id ===
            this.store.entity("projects", projectId).host_id,
          "HOST_MISMATCH",
          "Member and working directory must use the same host",
        );
    }
    const id = uuid();
    this.store.run(
      "INSERT INTO channels(id,workspace_id,name,topic,project_id) VALUES (?,?,?,?,?)",
      id,
      ws,
      name,
      topic,
      projectId,
    );
    for (const agentId of agentIds)
      this.store.run(
        "INSERT INTO channel_members VALUES (?,?,?)",
        id,
        agentId,
        now(),
      );
    return this.updated("Channel", id, ws);
  }
  setChannelMembers(
    channelId: string,
    agentIds: string[],
    expectedVersion: number,
  ) {
    const db = this.store,
      c = db.entity("channels", channelId);
    this.version(c, expectedVersion);
    for (const id of agentIds) {
      this.scope("agents", id, c.workspace_id);
      if (c.project_id)
        invariant(
          db.entity("agents", id).host_id ===
            db.entity("projects", c.project_id).host_id,
          "HOST_MISMATCH",
          "Member and working directory must use the same host",
        );
    }
    db.run("DELETE FROM channel_members WHERE channel_id=?", c.id);
    for (const id of agentIds)
      db.run("INSERT INTO channel_members VALUES (?,?,?)", c.id, id, now());
    // Only pending work in this conversation is withdrawn. A reserved turn
    // retains its ownership until it finishes; other conversations are untouched.
    for (const d of db.all(
      "SELECT d.id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.channel_id=? AND d.state='pending' AND NOT EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id=m.channel_id AND cm.agent_id=d.agent_id)",
      c.id,
    )) {
      db.run(
        "UPDATE deliveries SET state='cancelled',error_code='PARTICIPATION_REMOVED' WHERE id=?",
        d.id,
      );
      this.updated("Delivery", d.id, c.workspace_id);
    }
    db.run("UPDATE channels SET version=version+1 WHERE id=?", c.id);
    return this.updated("Channel", c.id, c.workspace_id);
  }
  closeIdleSession(agent: Row) {
    const db = this.store;
    if (
      db.get(
        "SELECT 1 FROM runs WHERE agent_id=? AND state NOT IN ('completed','failed','interrupted')",
        agent.id,
      )
    )
      return;
    const session = db.get(
      "SELECT * FROM agent_sessions WHERE agent_id=? AND state='ready'",
      agent.id,
    );
    if (!session || this.sessionClosing(session.launch_id)) return;
    db.run(
      "UPDATE agent_sessions SET state='recovering' WHERE id=?",
      session.id,
    );
    this.operation(
      agent.host_id,
      "runtime.close",
      { agentId: agent.id, reason: "shutdown", reset: false },
      agent.workspace_id,
      session.launch_id,
    );
  }
  sessionClosing(launchId: string) {
    return !!this.store.get(
      "SELECT 1 FROM host_commands WHERE kind='runtime.close' AND json_extract(payload_json,'$.launchId')=? AND state NOT IN ('completed','failed','cancelled')",
      launchId,
    );
  }
  createAgent(ws: string, b: Row) {
    invariant(
      !b.capabilities?.includes("desktop.request") ||
        computerUseAllowed(b.runtime.permissionProfile, b.capabilities),
      "COMPUTER_PERMISSION_MODE",
      "Computer Use 仅支持 Auto Approve 或 Full Access",
      400,
    );
    const project = this.scope("projects", b.projectId, ws);
    invariant(project.host_id === b.hostId, "SCOPE_DENIED", "Host mismatch");
    this.store.entity("hosts", b.hostId);
    const id = uuid();
    this.store.run(
      "INSERT INTO principals VALUES (?,'agent',?,?)",
      id,
      b.name,
      now(),
    );
    this.store.run(
      "INSERT INTO agents(id,workspace_id,host_id,project_id,name,role_text,runtime_json,capabilities_json,desired_state,observed_state) VALUES (?,?,?,?,?,?,?,?,'stopped','stopped')",
      id,
      ws,
      b.hostId,
      b.projectId,
      b.name,
      b.role,
      JSON.stringify(b.runtime),
      JSON.stringify(b.capabilities ?? []),
    );
    return this.updated("Agent", id, ws);
  }
  post(
    channelId: string,
    b: Row,
    actor = this.auth.owner,
    caller?: BoundToolCaller,
  ) {
    const channel = this.store.entity("channels", channelId),
      ws = channel.workspace_id;
    invariant(
      !channel.archived && this.workspace(ws).state !== "archived",
      "WORKSPACE_INACTIVE",
      "Channel inactive",
    );
    const recipients: string[] = b.recipientAgentIds ?? [];
    for (const id of recipients) {
      this.scope("agents", id, ws);
      invariant(
        this.store.get(
          "SELECT 1 FROM channel_members WHERE channel_id=? AND agent_id=?",
          channelId,
          id,
        ),
        "NOT_MEMBER",
        "Recipient is not a channel member",
      );
    }
    if (b.threadId) {
      const thread = this.store.entity("threads", b.threadId);
      invariant(
        thread.channel_id === channelId,
        "SCOPE_DENIED",
        "Thread mismatch",
      );
    }
    let reply: Row | undefined;
    if (b.replyToMessageId) {
      reply = this.store.entity("messages", b.replyToMessageId);
      invariant(
        reply.channel_id === channelId &&
          reply.thread_id === (b.threadId ?? null),
        "SCOPE_DENIED",
        "Reply thread mismatch",
      );
    }
    assertMessageLimits(b.blocks);
    for (const block of b.blocks)
      if (block.type === "artifact") {
        const a = this.scope("artifacts", block.artifactId, ws);
        invariant(
          !a.private_run_id,
          "ARTIFACT_DENIED",
          "Private context cannot be shared",
        );
      }
    let episode: string,
      depth = 0;
    if (caller) {
      const run = this.scopeRun(caller);
      if (
        b.kind === "answer" &&
        b.replyToMessageId === run.primary_message_id &&
        run.final_message_id
      )
        return this.get("Message", run.final_message_id);
      episode = run.episode_id;
      depth =
        this.store.entity("messages", run.primary_message_id).causal_depth + 1;
      invariant(
        recipients.length <= 3,
        "FANOUT_LIMIT",
        "Agent fanout limited to three",
      );
    } else if (b.continuationEpisodeId) {
      episode = b.continuationEpisodeId;
      this.scope("episodes", episode, ws);
    } else if (reply) {
      episode = reply.episode_id;
    } else {
      episode = uuid();
      const budget = {
        ...defaultBudget,
        ...json(this.workspace(ws).policy_json, {})?.episode,
      };
      this.store.run(
        "INSERT INTO episodes(id,workspace_id,state,budget_json,max_native_turns,created_at) VALUES (?,?,'open',?,?,?)",
        episode,
        ws,
        JSON.stringify(budget),
        budget.maxNativeTurns,
        now(),
      );
    }
    if (reply)
      invariant(
        reply.episode_id === episode,
        "EPISODE_MISMATCH",
        "Reply must inherit episode",
      );
    const id = uuid();
    this.store.run(
      "INSERT INTO messages(id,workspace_id,channel_id,thread_id,reply_to_message_id,actor_id,blocks_json,kind,request_response,episode_id,causal_depth,run_id,client_message_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      ws,
      channelId,
      b.threadId ?? null,
      b.replyToMessageId ?? null,
      actor,
      JSON.stringify(b.blocks),
      b.kind,
      b.requestResponse ? 1 : 0,
      episode,
      depth,
      caller?.runId ?? null,
      b.clientMessageId ?? uuid(),
      now(),
    );
    this.store.run(
      "UPDATE episodes SET root_message_id=COALESCE(root_message_id,?) WHERE id=?",
      id,
      episode,
    );
    for (const target of recipients) {
      this.store.run("INSERT INTO message_recipients VALUES (?,?)", id, target);
      this.delivery(
        id,
        target,
        b.requestResponse
          ? caller
            ? "mention"
            : recipients.length > 1
              ? "human_broadcast"
              : "mention"
          : "context",
      );
      if (caller && b.requestResponse)
        this.store.run(
          "INSERT INTO response_expectations(id,request_message_id,requester_agent_id,responder_agent_id,state) VALUES (?,?,?,?,'pending')",
          uuid(),
          id,
          actor,
          target,
        );
    }
    if (!b.requestResponse) {
      for (const member of this.store.all(
        "SELECT agent_id FROM channel_members WHERE channel_id=?",
        channelId,
      ))
        if (member.agent_id !== actor)
          this.delivery(id, member.agent_id, "context");
    }
    if (reply && b.kind === "answer")
      for (const ex of this.store.all(
        "SELECT * FROM response_expectations WHERE request_message_id=? AND state='pending'",
        reply.id,
      )) {
        if (actor === ex.responder_agent_id || actor === this.auth.owner) {
          this.store.run(
            "UPDATE response_expectations SET state='answered',response_message_id=? WHERE id=? AND state='pending'",
            id,
            ex.id,
          );
          this.delivery(id, ex.requester_agent_id, "requested_reply");
        }
      }
    if (caller && b.kind === "answer") {
      const run = this.store.entity("runs", caller.runId);
      if (b.replyToMessageId === run.primary_message_id)
        this.store.run(
          "UPDATE runs SET final_message_id=COALESCE(final_message_id,?) WHERE id=?",
          id,
          caller.runId,
        );
    }
    const seq = this.event(
      ws,
      "message.created",
      "message",
      this.get("Message", id),
      actor,
    );
    this.store.run(
      "UPDATE messages SET published_event_seq=? WHERE id=?",
      BigInt(seq),
      id,
    );
    const message = this.get("Message", id);
    this.store.run(
      "UPDATE events SET payload_json=? WHERE seq=?",
      JSON.stringify({ message }),
      BigInt(seq),
    );
    return message;
  }
  delivery(messageId: string, agentId: string, reason: string) {
    if (
      !this.store.get(
        "SELECT 1 FROM messages m JOIN channel_members cm ON cm.channel_id=m.channel_id WHERE m.id=? AND cm.agent_id=?",
        messageId,
        agentId,
      )
    )
      return;
    const pending = this.store.get(
      "SELECT count(*) n FROM deliveries WHERE agent_id=? AND state IN ('pending','reserved') AND reason<>'context'",
      agentId,
    )!.n;
    invariant(
      reason === "context" || pending < 200,
      "INBOX_FULL",
      "Agent inbox at capacity",
      429,
    );
    this.store.run(
      "INSERT INTO deliveries(id,agent_id,message_id,reason,state,created_at) VALUES (?,?,?,?,'pending',?) ON CONFLICT(agent_id,message_id) DO UPDATE SET reason=CASE WHEN deliveries.reason='context' AND excluded.reason<>'context' AND deliveries.state='pending' THEN excluded.reason ELSE deliveries.reason END",
      uuid(),
      agentId,
      messageId,
      reason,
      now(),
    );
  }
  scopeRun(caller: BoundToolCaller) {
    const agent = this.scope("agents", caller.agentId, caller.workspaceId),
      run = this.store.entity("runs", caller.runId);
    invariant(
      run.agent_id === agent.id &&
        run.launch_id === caller.launchId &&
        run.session_id === caller.sessionId &&
        ACTIVE_RUNS.includes(run.state),
      "STALE_LAUNCH",
      "Tool caller binding expired",
      403,
    );
    return run;
  }
  createTask(ws: string, b: Row, actor: string) {
    const channel = this.scope("channels", b.channelId, ws);
    const thread = this.store.entity("threads", b.threadId);
    invariant(
      thread.channel_id === channel.id,
      "SCOPE_DENIED",
      "Task thread mismatch",
    );
    if (b.sourceMessageId) {
      const source = this.scope("messages", b.sourceMessageId, ws);
      invariant(
        source.channel_id === channel.id,
        "SCOPE_DENIED",
        "Task source mismatch",
      );
      const old = this.store.get(
        "SELECT * FROM tasks WHERE source_message_id=?",
        source.id,
      );
      if (old) return this.dto("Task", old);
    }
    if (b.reviewerAgentId) this.scope("agents", b.reviewerAgentId, ws);
    const id = uuid();
    this.store.run(
      "INSERT INTO tasks(id,workspace_id,channel_id,thread_id,source_message_id,title,description,acceptance_json,status,reviewer_agent_id) VALUES (?,?,?,?,?,?,?,?,'todo',?)",
      id,
      ws,
      b.channelId,
      b.threadId,
      b.sourceMessageId ?? null,
      b.title,
      b.description,
      JSON.stringify(b.acceptanceCriteria),
      b.reviewerAgentId ?? null,
    );
    for (const dep of b.dependencyTaskIds ?? []) {
      this.scope("tasks", dep, ws);
      invariant(
        !hasCycle(
          this.store
            .all("SELECT task_id,depends_on_id FROM task_dependencies")
            .map((r) => [r.task_id, r.depends_on_id]),
          id,
          dep,
        ),
        "CYCLE",
        "Task dependency cycle",
      );
      this.store.run("INSERT INTO task_dependencies VALUES (?,?)", id, dep);
    }
    return this.updated("Task", id, ws, actor, "task.created");
  }
  claim(
    taskId: string,
    agentId: string,
    expected: number,
    actor: string,
    caller?: BoundToolCaller,
  ) {
    const task = this.store.entity("tasks", taskId);
    this.version(task, expected);
    this.scope("agents", agentId, task.workspace_id);
    invariant(
      !task.reviewer_agent_id || task.reviewer_agent_id !== agentId,
      "SELF_REVIEW",
      "Reviewer cannot own task",
    );
    invariant(
      !this.store.get(
        "SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_id WHERE d.task_id=? AND t.status<>'done'",
        taskId,
      ),
      "DEPENDENCIES_PENDING",
      "Task dependencies not complete",
    );
    const result = this.store.run(
      "UPDATE tasks SET status='in_progress',assignee_agent_id=?,lease_epoch=lease_epoch+1,lease_expires_ms=?,version=version+1 WHERE id=? AND version=? AND (status='todo' OR (status='blocked' AND assignee_agent_id=?))",
      agentId,
      Date.now() + 600000,
      taskId,
      expected,
      agentId,
    );
    invariant(result.changes === 1, "TASK_OWNED", "Task already owned", 409);
    if (caller) {
      const run = this.scopeRun(caller);
      invariant(
        !run.task_id || run.task_id === taskId,
        "ACTIVE_TASK_EXISTS",
        "Run already has a primary task",
      );
      this.store.run("UPDATE runs SET task_id=? WHERE id=?", taskId, run.id);
    } else {
      this.post(
        task.channel_id,
        {
          threadId: task.thread_id,
          blocks: [{ type: "text", text: `Assigned task: ${task.title}` }],
          recipientAgentIds: [agentId],
          requestResponse: true,
          kind: "system",
          clientMessageId: uuid(),
        },
        this.auth.system,
      );
    }
    return this.updated(
      "Task",
      taskId,
      task.workspace_id,
      actor,
      "task.claimed",
    );
  }
  transition(taskId: string, b: Row, actor: string) {
    const t = this.store.entity("tasks", taskId);
    this.version(t, b.expectedVersion);
    invariant(
      t.lease_epoch === b.leaseEpoch,
      "STALE_LEASE",
      "Task lease changed",
      409,
    );
    const ids = [...new Set<string>(b.artifactIds ?? [])];
    const existing = this.store.all(
      "SELECT artifact_id FROM task_artifacts WHERE task_id=?",
      taskId,
    );
    canTransitionTask(
      t.status,
      b.status,
      t.assignee_agent_id,
      t.reviewer_agent_id,
      actor,
      actor === this.auth.owner,
      ids.length + existing.length,
    );
    if (["done", "in_review", "blocked"].includes(b.status))
      invariant(
        typeof b.reason === "string" && b.reason.trim(),
        "REASON_REQUIRED",
        "Provide acceptance evidence or blocker",
      );
    if (b.status === "todo")
      invariant(
        !this.store.get(
          "SELECT 1 FROM runs WHERE agent_id=? AND state NOT IN ('completed','failed','interrupted')",
          t.assignee_agent_id,
        ),
        "OWNER_STILL_RUNNING",
        "Stop and reconcile former owner first",
      );
    for (const id of ids) {
      const artifact = this.scope("artifacts", id, t.workspace_id);
      invariant(
        !artifact.private_run_id,
        "ARTIFACT_DENIED",
        "Private context is not review evidence",
      );
      this.store.run(
        "INSERT OR IGNORE INTO task_artifacts VALUES (?,?)",
        taskId,
        id,
      );
      this.store.run(
        "UPDATE artifacts SET retention_class='durable' WHERE id=?",
        id,
      );
    }
    this.store.run(
      "UPDATE tasks SET status=?,version=version+1,assignee_agent_id=CASE WHEN ?='todo' THEN NULL ELSE assignee_agent_id END WHERE id=?",
      b.status,
      b.status,
      taskId,
    );
    this.store.run(
      "INSERT INTO task_history VALUES (?,?,?,?,?)",
      uuid(),
      taskId,
      actor,
      b.reason ?? "",
      now(),
    );
    return this.updated("Task", taskId, t.workspace_id, actor);
  }
  memory(ws: string, b: Row, actor: string) {
    this.workspace(ws);
    if (b.scope === "agent") this.scope("agents", b.ownerId, ws);
    if (b.scope === "thread") {
      const t = this.store.entity("threads", b.ownerId);
      this.scope("channels", t.channel_id, ws);
    }
    if (b.scope === "workspace")
      invariant(!b.ownerId, "INVALID_SCOPE", "Workspace memory has no owner");
    for (const id of b.sourceMessageIds) this.scope("messages", id, ws);
    const id = uuid();
    this.store.run(
      "INSERT INTO memories(id,workspace_id,scope,owner_id,title,body,sources_json,status,author_id,created_at) VALUES (?,?,?,?,?,?,?,'proposed',?,?)",
      id,
      ws,
      b.scope,
      b.ownerId ?? null,
      b.title,
      b.body,
      JSON.stringify(b.sourceMessageIds),
      actor,
      now(),
    );
    return this.updated("Memory", id, ws, actor);
  }
  list(
    type: string,
    ws: string,
    filter: Row = {},
    cursor?: string,
    limit = 50,
  ) {
    const table = tableFor[type]!;
    invariant(table, "INVALID_COLLECTION", "Unknown collection");
    invariant(
      Number.isInteger(limit) && limit >= 1,
      "INVALID_LIMIT",
      "Limit must be a positive integer",
      400,
    );
    limit = Math.min(200, limit);
    const clauses: string[] = [],
      params: any[] = [];
    if (
      ws &&
      ["workspaces", "hosts"].includes(table) === false &&
      type !== "Session" &&
      type !== "Delivery" &&
      type !== "Run" &&
      type !== "Operation"
    ) {
      clauses.push("workspace_id=?");
      params.push(ws);
    }
    for (const [key, value] of Object.entries(filter)) {
      invariant(/^[a-z_]+$/.test(key), "INVALID_FILTER", "Invalid filter");
      clauses.push(`${key}=?`);
      params.push(value);
    }
    if (type === "Agent") clauses.push("deleted_at IS NULL");
    if (type === "Artifact")
      clauses.push("deleted_at IS NULL AND private_run_id IS NULL");
    const sort = type === "Message" ? "published_event_seq" : "id";
    if (cursor) {
      const c = this.cursor.decode(cursor, ws, type, filter);
      clauses.push(`${sort}>?`);
      params.push(type === "Message" ? BigInt(c.lastSortKey) : c.lastSortKey);
    }
    const rows = this.store.all(
      `SELECT * FROM ${table}${clauses.length ? " WHERE " + clauses.join(" AND ") : ""} ORDER BY ${sort} LIMIT ?`,
      ...params,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    return {
      items: rows.map((r) => this.dto(type, r)),
      nextCursor:
        hasMore && last
          ? this.cursor.encode(
              ws,
              type,
              filter,
              type === "Message"
                ? this.store.seq(
                    "SELECT published_event_seq FROM messages WHERE id=?",
                    last.id,
                  )
                : last.id,
              last.id,
            )
          : null,
    };
  }
  conversationActivity(channelId: string) {
    const db = this.store;
    db.entity("channels", channelId);
    return {
      items: db.all(
        `SELECT d.id,d.agent_id AS agentId,a.name AS agentName,m.id AS messageId,m.created_at AS createdAt,
        a.observed_state AS agentState,h.state AS hostState,e.state AS episodeState,
        EXISTS(SELECT 1 FROM runs r WHERE r.agent_id=a.id AND r.state NOT IN ('completed','failed','interrupted')) AS busy
       FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN agents a ON a.id=d.agent_id
       JOIN hosts h ON h.id=a.host_id JOIN episodes e ON e.id=m.episode_id
       JOIN channel_members cm ON cm.channel_id=m.channel_id AND cm.agent_id=a.id
       WHERE m.channel_id=? AND d.state IN ('pending','reserved') AND d.reason<>'context'
       AND (d.run_id IS NULL OR NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=d.run_id AND r.state NOT IN ('completed','failed','interrupted')))
       ORDER BY m.published_event_seq,d.id`,
        channelId,
      ),
    };
  }
  snapshot(ws: string) {
    return this.store.read(() => ({
      workspace: this.get("Workspace", ws),
      snapshotSeq: this.store.seq("SELECT COALESCE(MAX(seq),0) FROM events"),
      retentionFrontier: this.store.seq(
        "SELECT seq FROM retention_frontiers WHERE workspace_id=?",
        ws,
      ),
      agents: this.list("Agent", ws, {}, undefined, 200).items,
      channels: this.list("Channel", ws, {}, undefined, 200).items,
      hosts: this.store
        .all(
          "SELECT DISTINCT h.* FROM hosts h JOIN agents a ON a.host_id=h.id WHERE a.workspace_id=?",
          ws,
        )
        .map((r) => this.dto("Host", r)),
      activeRuns: this.store
        .all(
          "SELECT r.* FROM runs r JOIN agents a ON a.id=r.agent_id WHERE a.workspace_id=? AND r.state NOT IN ('completed','failed','interrupted')",
          ws,
        )
        .map((r) => this.dto("Run", r)),
      approvals: this.store
        .all(
          "SELECT * FROM approvals WHERE workspace_id=? AND state='pending'",
          ws,
        )
        .map((r) => this.dto("Approval", r)),
    }));
  }
  events(ws: string, after: string) {
    invariant(
      /^\d+$/.test(after),
      "INVALID_CURSOR",
      "SSE cursor must be decimal",
      400,
    );
    this.workspace(ws);
    invariant(
      BigInt(after) >=
        BigInt(
          this.store.seq(
            "SELECT seq FROM retention_frontiers WHERE workspace_id=?",
            ws,
          ),
        ),
      "REPLAY_WINDOW_EXPIRED",
      "Reload workspace snapshot",
      410,
    );
    invariant(
      BigInt(after) <=
        BigInt(this.store.seq("SELECT COALESCE(MAX(seq),0) FROM events")),
      "INVALID_CURSOR",
      "Cursor exceeds committed sequence",
      400,
    );
    return this.store
      .all(
        "SELECT *,CAST(seq AS TEXT) wire_seq FROM events WHERE workspace_id=? AND seq>? ORDER BY seq LIMIT 500",
        ws,
        BigInt(after),
      )
      .map((r) => ({
        schemaVersion: 1,
        eventId: r.event_id,
        seq: r.wire_seq,
        workspaceId: r.workspace_id,
        type: r.event_type,
        occurredAt: r.occurred_at,
        actor: this.actor(r.actor_id),
        entityId: r.entity_id,
        payload: json(r.payload_json),
      }));
  }
}
