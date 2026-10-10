-- Implementation extensions to the supplied schema. Applied transactionally.
ALTER TABLE workspaces ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE artifacts ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE artifacts ADD COLUMN private_run_id TEXT;
        ALTER TABLE operations ADD COLUMN workspace_id TEXT;
        CREATE TABLE retention_frontiers(workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),seq INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE task_history(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE executable_profiles(id TEXT PRIMARY KEY,host_id TEXT NOT NULL,profile_json TEXT NOT NULL);
        CREATE TABLE runtime_digests(launch_id TEXT NOT NULL,producer_seq INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(launch_id,producer_seq));
        CREATE TABLE worktree_operations(agent_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,path TEXT,state TEXT NOT NULL);
        CREATE TABLE usage_measurements(run_id TEXT NOT NULL,measurement_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,measurement_id));
        CREATE TABLE read_contexts(run_id TEXT NOT NULL,delivery_id TEXT NOT NULL,PRIMARY KEY(run_id,delivery_id));
        CREATE TABLE run_config(run_id TEXT PRIMARY KEY,config_json TEXT NOT NULL);
        CREATE TABLE budget_refunds(run_id TEXT PRIMARY KEY);
