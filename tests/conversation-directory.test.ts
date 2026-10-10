import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { execute } from "../apps/control/src/api.js";
import { Scheduler } from "../apps/control/src/runtime.js";
import { uuid } from "../packages/persistence/src/index.js";
function start(
  f: ReturnType<typeof fixture>,
  projectId: string,
  text = "检查项目",
  key = uuid(),
) {
  const body = {
    projectId,
    agentIds: [f.agents[0]!.id],
    message: { ...f.message([f.agents[0]!.id], text), threadId: undefined },
  };
  return {
    body,
    key,
    send: () =>
      f.s.mutate(f.s.auth.owner, "startConversation", key, body, () =>
        execute(f.s, "startConversation", { workspaceId: f.ws.id }, body),
      ),
  };
}
test("First send atomically creates folder-bound conversation, title, participants and message; retry does not create another", () => {
  const f = fixture();
  try {
    const call = start(f, f.project);
    const m = call.send(),
      again = call.send();
    assert.equal(m.id, again.id);
    const c = f.s.get("Channel", m.channelId);
    assert.equal(c.projectId, f.project);
    assert.equal(c.name, "检查项目");
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM channel_members WHERE channel_id=?",
        c.id,
      )!.n,
      1,
    );
    const before = f.db.get("SELECT count(*) n FROM channels")!.n;
    const bad = start(f, f.project);
    bad.body.message.recipientAgentIds = [f.agents[1]!.id];
    assert.throws(() => bad.send());
    assert.equal(f.db.get("SELECT count(*) n FROM channels")!.n, before);
    const second = start(f, f.project).send();
    assert.equal(f.s.get("Channel", second.channelId).name, "检查项目 (2)");
  } finally {
    f.db.close();
  }
});
test("Actual execution uses conversation directory and restores only that conversation native context when switching back", () => {
  const f = fixture();
  try {
    f.s.connectedHosts.add(f.host);
    f.db.run(
      "UPDATE projects SET workspace_mode='directory' WHERE id=?",
      f.project,
    );
    const other = uuid();
    f.db.run(
      "INSERT INTO projects(id,workspace_id,host_id,name,root_path,base_ref,workspace_mode) VALUES (?,?,?,'second','/tmp/second-folder','HEAD','directory')",
      other,
      f.ws.id,
      f.host,
    );
    const a = start(f, other, "对话 A").send(),
      sched = new Scheduler(f.s);
    sched.tick();
    const first = f.db.get("SELECT * FROM agent_sessions")!;
    assert.equal(first.workspace_path, "/tmp/second-folder");
    assert.equal(first.channel_id, a.channelId);
    const command = JSON.parse(
      f.db.get(
        "SELECT payload_json FROM host_commands WHERE kind='runtime.open'",
      )!.payload_json,
    );
    assert.equal(command.payload.project.id, other);
    assert.equal(command.payload.session.channelId, a.channelId);
    f.db.run(
      "UPDATE deliveries SET state='cancelled' WHERE message_id=?",
      a.id,
    );
    f.db.run(
      "UPDATE agent_sessions SET state='ready',native_session_id='native-A' WHERE id=?",
      first.id,
    );
    const b = start(f, f.project, "对话 B").send();
    sched.tick();
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM host_commands WHERE kind='runtime.close'",
      )!.n,
      1,
    );
    f.db.run("UPDATE agent_sessions SET state='closed' WHERE id=?", first.id);
    sched.tick();
    const second = f.db.get(
      "SELECT * FROM agent_sessions ORDER BY generation DESC LIMIT 1",
    )!;
    assert.equal(second.workspace_path, f.dir);
    assert.equal(second.native_session_id, null);
    assert.equal(second.channel_id, b.channelId);
    f.db.run(
      "UPDATE deliveries SET state='cancelled' WHERE message_id=?",
      b.id,
    );
    f.db.run(
      "UPDATE agent_sessions SET state='closed',native_session_id='native-B' WHERE id=?",
      second.id,
    );
    f.s.post(a.channelId, {
      ...f.message([f.agents[0]!.id], "继续 A"),
      threadId: undefined,
    });
    sched.tick();
    const third = f.db.get(
      "SELECT * FROM agent_sessions ORDER BY generation DESC LIMIT 1",
    )!;
    assert.equal(third.native_session_id, "native-A");
    assert.equal(third.workspace_path, "/tmp/second-folder");
  } finally {
    f.db.close();
  }
});
