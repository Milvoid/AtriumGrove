import { test } from "node:test";
import assert from "node:assert/strict";
import { runFixture } from "./helpers.js";
import { uuid, now, sha } from "../packages/persistence/src/index.js";
import { collaboration } from "../apps/control/src/collaboration.js";
import { execute } from "../apps/control/src/api.js";
import { ingest } from "../apps/control/src/runtime.js";

test("A26: shared image artifact returns an actual MCP image block", () => {
  const f = runFixture();
  try {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=",
      "base64",
    );
    const id = f.s.artifacts.put(
      f.ws.id,
      f.agents[1]!.id,
      bytes,
      "fixture.png",
      "image",
    );
    const result = collaboration(
      f.s,
      {
        workspaceId: f.ws.id,
        agentId: f.agent.id,
        sessionId: f.session,
        launchId: f.launch,
        runId: f.run,
        capabilities: [],
        channelIds: [],
      },
      "artifact_read",
      { artifactId: id },
    );
    const image = result.content.find((b: any) => b.type === "image");
    assert.equal(image?.mimeType, "image/png");
    assert.deepEqual(Buffer.from(image!.data as string, "base64"), bytes);
  } finally {
    f.db.close();
  }
});

test("A09 A15: peer answer promotes context delivery once and inherits episode", () => {
  const f = runFixture();
  try {
    const a = {
      workspaceId: f.ws.id,
      agentId: f.agent.id,
      sessionId: f.session,
      launchId: f.launch,
      runId: f.run,
      capabilities: [],
      channelIds: [],
    };
    const question = f.s.post(
      f.channel.id,
      {
        ...f.message([f.agents[1]!.id], "Please review", true),
        kind: "question",
      },
      f.agent.id,
      a,
    );
    assert.equal(question.episodeId, f.db.entity("runs", f.run).episode_id);
    assert.equal(f.db.entity("messages", question.id).causal_depth, 1);
    const session = uuid(),
      launch = uuid(),
      run = uuid(),
      agentId = f.agents[1]!.id;
    f.db.run(
      "INSERT INTO agent_sessions(id,agent_id,driver,launch_id,generation,state,workspace_path,config_digest,created_at) VALUES (?,?,'codex-app-server',?,1,'busy',?,'test',?)",
      session,
      agentId,
      launch,
      f.dir,
      now(),
    );
    f.db.run(
      "INSERT INTO runs(id,agent_id,session_id,episode_id,primary_message_id,launch_id,state,context_digest) VALUES (?,?,?,?,?,?,'running','test')",
      run,
      agentId,
      session,
      question.episodeId,
      question.id,
      launch,
    );
    const caller = {
      workspaceId: f.ws.id,
      agentId,
      sessionId: session,
      launchId: launch,
      runId: run,
      capabilities: [],
      channelIds: [],
    };
    const body = {
      threadId: f.thread,
      replyToMessageId: question.id,
      blocks: [{ type: "text", text: "Reviewed" }],
      recipientAgentIds: [],
      requestResponse: false,
      kind: "answer",
      clientMessageId: uuid(),
    };
    const answer = f.s.post(f.channel.id, body, agentId, caller);
    assert.equal(
      f.db.get(
        "SELECT reason FROM deliveries WHERE message_id=? AND agent_id=?",
        answer.id,
        f.agent.id,
      )!.reason,
      "requested_reply",
    );
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM response_expectations WHERE state='answered'",
      )!.n,
      1,
    );
    assert.equal(
      f.s.post(
        f.channel.id,
        { ...body, clientMessageId: uuid() },
        agentId,
        caller,
      ).id,
      answer.id,
    );
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM deliveries WHERE agent_id=? AND reason='requested_reply'",
        f.agent.id,
      )!.n,
      1,
    );
  } finally {
    f.db.close();
  }
});

test("A33 A35: approval requires matching hash, native launch and one version", () => {
  const f = runFixture();
  try {
    const id = uuid(),
      hash = sha("input");
    ingest(
      f.s,
      f.host,
      f.event(
        {
          kind: "approval.requested",
          request: {
            approvalId: id,
            runId: f.run,
            launchId: f.launch,
            nativeRequestId: "native-1",
            source: "codex",
            kind: "form",
            title: "Test approval",
            inputSchema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
              additionalProperties: false,
            },
            display: { test: true },
            allowedActions: ["approve", "deny", "cancel"],
            argumentHash: hash,
          },
        },
        1,
      ),
    );
    const decision = {
      expectedVersion: 1,
      argumentHash: hash,
      action: "approve",
      content: { answer: "human input" },
    };
    assert.throws(
      () =>
        f.s.mutate(f.s.auth.owner, "approve", uuid(), {}, () =>
          execute(
            f.s,
            "resolveApproval",
            { approvalId: id },
            { ...decision, argumentHash: sha("changed") },
          ),
        ),
      /changed/,
    );
    assert.throws(
      () =>
        f.s.mutate(f.s.auth.owner, "approve", uuid(), {}, () =>
          execute(
            f.s,
            "resolveApproval",
            { approvalId: id },
            { ...decision, content: {} },
          ),
        ),
      /required/,
    );
    f.s.mutate(f.s.auth.owner, "approve", uuid(), {}, () =>
      execute(f.s, "resolveApproval", { approvalId: id }, decision),
    );
    assert.throws(
      () =>
        f.s.mutate(f.s.auth.owner, "approve", uuid(), {}, () =>
          execute(f.s, "resolveApproval", { approvalId: id }, decision),
        ),
      /version/i,
    );
    assert.equal(
      f.db.get(
        "SELECT count(*) n FROM host_commands WHERE kind='approval.respond'",
      )!.n,
      1,
    );
  } finally {
    f.db.close();
  }
});
