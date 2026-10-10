-- Separate local Host database; never share this file with the control plane.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
CREATE TABLE host_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE launches (
 launch_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
 native_session_id TEXT, driver TEXT NOT NULL, pid INTEGER, pid_started_at TEXT,
 state TEXT NOT NULL, executable_realpath TEXT NOT NULL, executable_digest TEXT NOT NULL,
 current_run_id TEXT, credential_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX live_agent ON launches(agent_id) WHERE state NOT IN('exited','failed','closed');
CREATE TABLE received_commands (
 command_id TEXT PRIMARY KEY, command_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('received','issuing','accepted','completed','failed','unknown','cancelled')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), response_json TEXT,
 launch_id TEXT, received_at TEXT NOT NULL
);
CREATE TABLE event_spool (
 launch_id TEXT NOT NULL, producer_seq INTEGER NOT NULL CHECK(producer_seq>0),
 event_json TEXT NOT NULL CHECK(json_valid(event_json)), acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN(0,1)),
 PRIMARY KEY(launch_id,producer_seq)
);
CREATE TABLE desktop_resources (
 resource_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN('unavailable','free','held','draining','quarantined')),
 lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch>=0),
 owner_launch_id TEXT, owner_run_id TEXT, expires_wall_ms INTEGER,
 pending_calls INTEGER NOT NULL DEFAULT 0 CHECK(pending_calls>=0),
 provider TEXT NOT NULL, provider_session_id TEXT, last_cleanup_receipt TEXT,
 diagnostic TEXT
);
CREATE TABLE desktop_calls (
 call_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES desktop_resources(resource_id),
 launch_id TEXT NOT NULL, run_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL,
 method TEXT NOT NULL, argument_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('queued','executing','waiting_approval','completed','failed','cancel_requested','unknown')),
 result_local_ref TEXT, started_at TEXT, ended_at TEXT
);
CREATE TABLE pending_approvals (
 approval_id TEXT PRIMARY KEY, launch_id TEXT NOT NULL, run_id TEXT NOT NULL,
 native_request_id TEXT NOT NULL, argument_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('pending','answered','cancelled','unknown')),
 response_json TEXT, created_at TEXT NOT NULL
);
