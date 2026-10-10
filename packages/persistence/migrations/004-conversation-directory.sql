ALTER TABLE channels ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE agent_sessions ADD COLUMN channel_id TEXT REFERENCES channels(id);
-- Only infer legacy folders when every member has the same actual execution project.
UPDATE channels SET project_id=(SELECT MIN(a.project_id) FROM channel_members cm JOIN agents a ON a.id=cm.agent_id WHERE cm.channel_id=channels.id HAVING COUNT(DISTINCT a.project_id)=1);
CREATE INDEX channels_project ON channels(project_id);
CREATE INDEX sessions_channel ON agent_sessions(agent_id,channel_id,generation);
