import { mkdtempSync } from "../scripts/test-resources.js";
import {} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, uuid, sha, now } from "../packages/persistence/src/index.js";
import { Service } from "../apps/control/src/service.js";
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "harbor-test-")),
    db = new Store(":memory:"),
    s = new Service(db, dir);
  const host = uuid(),
    credential = uuid();
  db.run(
    "INSERT INTO hosts(id,name,credential_hash,platform,architecture,state) VALUES (?,'test',?,'darwin','arm64','online')",
    host,
    sha(credential),
  );
  const ws = s.createWorkspace("test"),
    channel = s.createChannel(ws.id, "general"),
    project = uuid(),
    thread = uuid();
  db.run(
    "INSERT INTO projects(id,workspace_id,host_id,name,root_path,base_ref,version) VALUES (?,?,?,?,?,?,1)",
    project,
    ws.id,
    host,
    "test",
    dir,
    "HEAD",
  );
  db.run(
    "INSERT INTO threads VALUES (?,?,?,'open',?)",
    thread,
    channel.id,
    "test",
    now(),
  );
  const agents = Array.from({ length: 5 }, (_, i) => {
    const a = s.createAgent(ws.id, {
      hostId: host,
      projectId: project,
      name: "agent-" + i,
      role: "test",
      runtime: {
        driver: i < 3 ? "codex-app-server" : "claude-code-sdk",
        executableProfile: "test",
        model: "default",
        permissionProfile: "workspace",
        settingsProfile: "project-reviewed",
      },
      capabilities: [
        "collab.read",
        "collab.post",
        "task.read",
        "task.claim",
        "task.transition",
        "task.review",
        "artifact.read",
        "artifact.register",
        "memory.propose",
      ],
    });
    db.run(
      "INSERT INTO channel_members VALUES (?,?,?)",
      channel.id,
      a.id,
      now(),
    );
    return a;
  });
  const message = (
    recipients = agents.map((a) => a.id),
    text = "Do the test",
    requestResponse = true,
  ) => ({
    threadId: thread,
    blocks: [{ type: "text", text }],
    recipientAgentIds: recipients,
    requestResponse,
    kind: "message",
    clientMessageId: uuid(),
  });
  return {
    dir,
    db,
    s,
    host,
    credential,
    ws,
    channel,
    project,
    thread,
    agents,
    message,
  };
}
export async function until(fn: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > deadline)
      throw new Error("State invariant not reached before timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function runFixture() {
  const f = fixture(),
    agent = f.agents[0]!,
    session = uuid(),
    launch = uuid(),
    run = uuid();
  const message = f.s.post(f.channel.id, f.message([agent.id]));
  f.db.run(
    "INSERT INTO agent_sessions(id,agent_id,driver,launch_id,generation,state,workspace_path,config_digest,created_at) VALUES (?,?,'codex-app-server',?,1,'busy',?,'digest',?)",
    session,
    agent.id,
    launch,
    f.dir,
    now(),
  );
  f.db.run(
    "INSERT INTO runs(id,agent_id,session_id,episode_id,primary_message_id,launch_id,state,context_digest) VALUES (?,?,?,?,?,?,'running','test')",
    run,
    agent.id,
    session,
    message.episodeId,
    message.id,
    launch,
  );
  return {
    ...f,
    agent,
    session,
    launch,
    run,
    event: (body: any, producerSeq: number) => ({
      ...body,
      launchId: launch,
      producerSeq,
      agentId: agent.id,
      sessionId: session,
      runId: run,
      lane: [],
      occurredAt: "2026-10-09T00:00:00.000Z",
    }),
  };
}
