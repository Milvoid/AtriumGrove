-- Atrium Grove control-plane database. A single control-plane process owns writes.
-- JSON is stored as TEXT. Service-layer transactions enforce cross-workspace
-- consistency and the state machines specified in PROTOCOLS.md.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE principals (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','agent','system')),
 display_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE auth_sessions (
 token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id),
 csrf_hash TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE login_nonces (
 token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE workspaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES principals(id),
 state TEXT NOT NULL CHECK(state IN ('active','paused','archived')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL
);
CREATE TABLE hosts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE,
 platform TEXT NOT NULL, architecture TEXT NOT NULL, boot_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('online','offline','degraded','revoked')),
 last_seen_at TEXT, capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json)),
 inventory_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(inventory_json))
);
CREATE TABLE projects (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 host_id TEXT NOT NULL REFERENCES hosts(id), name TEXT NOT NULL, root_path TEXT NOT NULL,
 base_ref TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(host_id,root_path,workspace_id)
);
CREATE TABLE agents (
 id TEXT PRIMARY KEY REFERENCES principals(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 host_id TEXT NOT NULL REFERENCES hosts(id), project_id TEXT NOT NULL REFERENCES projects(id),
 name TEXT NOT NULL, role_text TEXT NOT NULL,
 runtime_json TEXT NOT NULL CHECK(json_valid(runtime_json)),
 capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json)),
 desired_state TEXT NOT NULL CHECK(desired_state IN ('running','paused','stopped')),
 observed_state TEXT NOT NULL CHECK(observed_state IN ('stopped','starting','idle','working','waiting_approval','recovering','degraded','unknown')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE(workspace_id,name)
);
CREATE TABLE channels (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE(workspace_id,name)
);
CREATE TABLE channel_members (
 channel_id TEXT NOT NULL REFERENCES channels(id), agent_id TEXT NOT NULL REFERENCES agents(id),
 joined_at TEXT NOT NULL, PRIMARY KEY(channel_id,agent_id)
);
CREATE TABLE threads (
 id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), title TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('open','paused','closed')), created_at TEXT NOT NULL
);
CREATE TABLE episodes (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), root_message_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('open','paused_budget','paused_human','complete')),
 budget_json TEXT NOT NULL CHECK(json_valid(budget_json)),
 native_turns_reserved INTEGER NOT NULL DEFAULT 0 CHECK(native_turns_reserved>=0),
 max_native_turns INTEGER NOT NULL CHECK(max_native_turns>0),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL,
 CHECK(native_turns_reserved<=max_native_turns)
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 channel_id TEXT NOT NULL REFERENCES channels(id), thread_id TEXT REFERENCES threads(id),
 reply_to_message_id TEXT REFERENCES messages(id), actor_id TEXT NOT NULL REFERENCES principals(id),
 blocks_json TEXT NOT NULL CHECK(json_valid(blocks_json)),
 kind TEXT NOT NULL CHECK(kind IN ('message','progress','question','answer','proposal','system')),
 request_response INTEGER NOT NULL CHECK(request_response IN(0,1)),
 episode_id TEXT NOT NULL REFERENCES episodes(id), causal_depth INTEGER NOT NULL DEFAULT 0 CHECK(causal_depth>=0),
 run_id TEXT, client_message_id TEXT NOT NULL, created_at TEXT NOT NULL,
 published_event_seq INTEGER UNIQUE,
 UNIQUE(actor_id,client_message_id)
);
CREATE INDEX messages_channel_page ON messages(channel_id,published_event_seq);
CREATE INDEX messages_thread_page ON messages(thread_id,published_event_seq);
CREATE TABLE message_recipients (
 message_id TEXT NOT NULL REFERENCES messages(id), agent_id TEXT NOT NULL REFERENCES agents(id),
 PRIMARY KEY(message_id,agent_id)
);
CREATE TABLE response_expectations (
 id TEXT PRIMARY KEY, request_message_id TEXT NOT NULL REFERENCES messages(id),
 requester_agent_id TEXT NOT NULL REFERENCES agents(id), responder_agent_id TEXT NOT NULL REFERENCES agents(id),
 response_message_id TEXT REFERENCES messages(id), state TEXT NOT NULL CHECK(state IN('pending','answered','expired','cancelled')),
 UNIQUE(request_message_id,responder_agent_id)
);
CREATE TABLE agent_sessions (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), driver TEXT NOT NULL,
 native_session_id TEXT, launch_id TEXT, generation INTEGER NOT NULL CHECK(generation>0),
 state TEXT NOT NULL CHECK(state IN ('opening','ready','busy','waiting_approval','recovering','closed','failed','unknown')),
 workspace_path TEXT NOT NULL, config_digest TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(agent_id,generation)
);
CREATE UNIQUE INDEX one_live_session_per_agent ON agent_sessions(agent_id)
 WHERE state NOT IN ('closed','failed');
CREATE UNIQUE INDEX one_native_owner ON agent_sessions(driver,native_session_id)
 WHERE native_session_id IS NOT NULL AND state NOT IN ('closed','failed');
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 channel_id TEXT NOT NULL REFERENCES channels(id), thread_id TEXT NOT NULL REFERENCES threads(id),
 source_message_id TEXT UNIQUE REFERENCES messages(id), title TEXT NOT NULL, description TEXT NOT NULL,
 acceptance_json TEXT NOT NULL CHECK(json_valid(acceptance_json)),
 status TEXT NOT NULL CHECK(status IN ('todo','in_progress','blocked','in_review','done','cancelled')),
 assignee_agent_id TEXT REFERENCES agents(id), reviewer_agent_id TEXT REFERENCES agents(id),
 lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch>=0), lease_expires_ms INTEGER,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK(status NOT IN ('in_progress','in_review') OR assignee_agent_id IS NOT NULL)
);
CREATE TABLE task_dependencies (
 task_id TEXT NOT NULL REFERENCES tasks(id), depends_on_id TEXT NOT NULL REFERENCES tasks(id),
 PRIMARY KEY(task_id,depends_on_id), CHECK(task_id<>depends_on_id)
);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), session_id TEXT NOT NULL REFERENCES agent_sessions(id),
 episode_id TEXT NOT NULL REFERENCES episodes(id), task_id TEXT REFERENCES tasks(id),
 primary_message_id TEXT NOT NULL REFERENCES messages(id), native_turn_id TEXT, launch_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('scheduled','dispatching','running','waiting_approval','draining','completed','failed','interrupted','unknown')),
 native_outcome TEXT CHECK(native_outcome IN ('completed','failed','interrupted')),
 context_digest TEXT NOT NULL, context_artifact_id TEXT,
 started_at TEXT, ended_at TEXT, error_code TEXT, final_message_id TEXT REFERENCES messages(id),
 pending_tool_count INTEGER NOT NULL DEFAULT 0 CHECK(pending_tool_count>=0)
);
CREATE UNIQUE INDEX one_active_run_per_agent ON runs(agent_id)
 WHERE state IN ('scheduled','dispatching','running','waiting_approval','draining','unknown');
CREATE TABLE deliveries (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), message_id TEXT NOT NULL REFERENCES messages(id),
 run_id TEXT REFERENCES runs(id), reason TEXT NOT NULL CHECK(reason IN('mention','human_broadcast','task','requested_reply','manual','context')),
 state TEXT NOT NULL CHECK(state IN ('pending','reserved','sent','cancelled','unknown')),
 attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0), not_before_ms INTEGER NOT NULL DEFAULT 0,
 reservation_id TEXT, created_at TEXT NOT NULL, error_code TEXT,
 UNIQUE(agent_id,message_id)
);
CREATE INDEX deliveries_pending ON deliveries(agent_id,state,not_before_ms,created_at);
CREATE TABLE delivery_evidence (
 delivery_id TEXT NOT NULL REFERENCES deliveries(id),
 kind TEXT NOT NULL CHECK(kind IN ('transport_written','native_ack','context_included','agent_ack')),
 producer_id TEXT NOT NULL, native_ref TEXT, context_digest TEXT, occurred_at TEXT NOT NULL,
 PRIMARY KEY(delivery_id,kind,producer_id)
);
CREATE TABLE agent_read_cursors (
 agent_id TEXT NOT NULL REFERENCES agents(id), channel_id TEXT NOT NULL REFERENCES channels(id),
 last_included_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_included_seq>=0),
 last_acked_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_acked_seq>=0),
 PRIMARY KEY(agent_id,channel_id)
);
CREATE TABLE runtime_events (
 id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id), boot_id TEXT NOT NULL,
 launch_id TEXT NOT NULL, producer_seq INTEGER NOT NULL CHECK(producer_seq>0),
 agent_id TEXT NOT NULL REFERENCES agents(id), session_id TEXT NOT NULL REFERENCES agent_sessions(id),
 run_id TEXT REFERENCES runs(id), native_turn_id TEXT, kind TEXT NOT NULL,
 lane_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(lane_json)),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), raw_local_ref TEXT, occurred_at TEXT NOT NULL,
 UNIQUE(launch_id,producer_seq)
);
CREATE INDEX runtime_events_run ON runtime_events(run_id,producer_seq);
CREATE TABLE approvals (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), agent_id TEXT NOT NULL REFERENCES agents(id),
 run_id TEXT NOT NULL REFERENCES runs(id), launch_id TEXT NOT NULL, native_request_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('codex','claude','computer-use')),
 kind TEXT NOT NULL CHECK(kind IN ('permission','question','form','url')),
 state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','cancelled','expired','resolved','unknown')),
 title TEXT NOT NULL, input_schema_json TEXT NOT NULL CHECK(json_valid(input_schema_json)),
 display_json TEXT NOT NULL CHECK(json_valid(display_json)), allowed_actions_json TEXT NOT NULL CHECK(json_valid(allowed_actions_json)),
 argument_hash TEXT NOT NULL, result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), created_at TEXT NOT NULL, expires_at TEXT, resolved_by TEXT REFERENCES principals(id),
 UNIQUE(launch_id,source,native_request_id)
);
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), creator_id TEXT NOT NULL REFERENCES principals(id),
 kind TEXT NOT NULL CHECK(kind IN ('file','image','diff','test_report','log','context')),
 filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), storage_key TEXT NOT NULL,
 retention_class TEXT NOT NULL CHECK(retention_class IN('durable','screenshot','diagnostic')),
 created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE task_artifacts (
 task_id TEXT NOT NULL REFERENCES tasks(id), artifact_id TEXT NOT NULL REFERENCES artifacts(id),
 PRIMARY KEY(task_id,artifact_id)
);
CREATE TABLE memories (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 scope TEXT NOT NULL CHECK(scope IN ('workspace','agent','thread')), owner_id TEXT,
 title TEXT NOT NULL, body TEXT NOT NULL, sources_json TEXT NOT NULL CHECK(json_valid(sources_json)),
 status TEXT NOT NULL CHECK(status IN ('proposed','accepted','superseded')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), author_id TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL
);
CREATE TABLE resource_projections (
 host_id TEXT NOT NULL REFERENCES hosts(id), resource_id TEXT NOT NULL,
 provider TEXT NOT NULL, qualified INTEGER NOT NULL CHECK(qualified IN(0,1)),
 state TEXT NOT NULL CHECK(state IN('unavailable','free','held','draining','quarantined')),
 lease_epoch INTEGER NOT NULL CHECK(lease_epoch>=0), owner_agent_id TEXT REFERENCES agents(id), owner_run_id TEXT REFERENCES runs(id),
 in_flight_calls INTEGER NOT NULL CHECK(in_flight_calls>=0), diagnostic TEXT,
 PRIMARY KEY(host_id,resource_id)
);
CREATE TABLE operations (
 id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN('accepted','running','completed','failed','unknown')),
 result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
 created_at TEXT NOT NULL
);
CREATE TABLE host_commands (
 id TEXT PRIMARY KEY REFERENCES operations(id), host_id TEXT NOT NULL REFERENCES hosts(id),
 controller_epoch TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 state TEXT NOT NULL CHECK(state IN('pending','sent','received','completed','failed','unknown','cancelled')),
 attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0), not_before_ms INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, ack_at TEXT
);
CREATE TABLE events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), event_type TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES principals(id), entity_id TEXT,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), occurred_at TEXT NOT NULL,
 source_key TEXT UNIQUE
);
CREATE INDEX events_workspace_replay ON events(workspace_id,seq);
CREATE TABLE idempotency_keys (
 principal_id TEXT NOT NULL REFERENCES principals(id), route_key TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL, response_status INTEGER NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)),
 created_at TEXT NOT NULL, PRIMARY KEY(principal_id,route_key,idempotency_key)
);
CREATE TABLE audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL REFERENCES principals(id),
 action TEXT NOT NULL, target_id TEXT, metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), occurred_at TEXT NOT NULL
);
INSERT INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
