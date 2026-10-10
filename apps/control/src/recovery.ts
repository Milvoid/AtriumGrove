import type { Service } from "./service.js";
import { now, type Row } from "../../../packages/persistence/src/index.js";

/** Reconnect is evidence collection, never permission to repeat a native turn. */
export function reconcileHost(s: Service, hostId: string, launches: Row[]) {
  const db = s.store;
  db.tx(() => {
    const reported = new Map(launches.map((l) => [l.launchId, l]));
    for (const session of db.all(
      "SELECT s.*,a.workspace_id FROM agent_sessions s JOIN agents a ON a.id=s.agent_id WHERE a.host_id=? AND s.state NOT IN ('closed','failed')",
      hostId,
    )) {
      const live = reported.get(session.launch_id);
      if (
        live &&
        ["closed", "exited"].includes(live.state) &&
        !db.get(
          "SELECT 1 FROM runs WHERE session_id=? AND state NOT IN ('completed','failed','interrupted')",
          session.id,
        )
      ) {
        db.run(
          "UPDATE agent_sessions SET state='closed' WHERE id=?",
          session.id,
        );
        db.run(
          "UPDATE agents SET observed_state='stopped' WHERE id=?",
          session.agent_id,
        );
        s.updated("Session", session.id, session.workspace_id);
        s.updated("Agent", session.agent_id, session.workspace_id);
        continue;
      }
      if (!live || ["unknown", "closed", "exited"].includes(live.state)) {
        // An opening command still in the durable outbox may not have reached the Host.
        if (
          !live &&
          session.state === "opening" &&
          db.get(
            "SELECT 1 FROM host_commands WHERE host_id=? AND kind='runtime.open' AND state='pending'",
            hostId,
          )
        )
          continue;
        db.run(
          "UPDATE agent_sessions SET state='unknown' WHERE id=?",
          session.id,
        );
        db.run(
          "UPDATE agents SET observed_state='unknown',desired_state='paused' WHERE id=?",
          session.agent_id,
        );
        for (const run of db.all(
          "SELECT id FROM runs WHERE session_id=? AND state NOT IN ('completed','failed','interrupted')",
          session.id,
        )) {
          db.run(
            "UPDATE runs SET state='unknown',error_code='PROCESS_CONTROL_LOST' WHERE id=?",
            run.id,
          );
          s.updated("Run", run.id, session.workspace_id);
        }
        s.updated("Session", session.id, session.workspace_id);
        s.updated("Agent", session.agent_id, session.workspace_id);
      }
    }
    // Same command identity and payload hash; a live Host returns its saved receipt.
    for (const command of db.all(
      "SELECT * FROM host_commands WHERE host_id=? AND state IN ('pending','sent','received')",
      hostId,
    )) {
      const envelope = JSON.parse(command.payload_json);
      envelope.controllerEpoch = s.controllerEpoch;
      envelope.expiresAt = new Date(Date.now() + 300000).toISOString();
      db.run(
        "UPDATE host_commands SET controller_epoch=?,payload_json=?,state='pending',not_before_ms=0 WHERE id=?",
        s.controllerEpoch,
        JSON.stringify(envelope),
        command.id,
      );
    }
  });
}

export function maintain(s: Service) {
  const db = s.store;
  db.tx(() => {
    db.run(
      "UPDATE tasks SET lease_expires_ms=? WHERE status='in_progress' AND EXISTS (SELECT 1 FROM runs r JOIN agents a ON a.id=r.agent_id JOIN hosts h ON h.id=a.host_id WHERE r.agent_id=tasks.assignee_agent_id AND r.task_id=tasks.id AND r.state IN ('running','waiting_approval') AND h.state='online' AND h.last_seen_at>?)",
      Date.now() + 600000,
      new Date(Date.now() - 30000).toISOString(),
    );
    for (const task of db.all(
      "SELECT * FROM tasks WHERE status='in_progress' AND lease_expires_ms<?",
      Date.now(),
    )) {
      // Keep the old owner: expiry is not proof its side effects stopped.
      db.run(
        "UPDATE tasks SET status='blocked',version=version+1 WHERE id=?",
        task.id,
      );
      s.updated("Task", task.id, task.workspace_id);
    }
    for (const approval of db.all(
      "SELECT * FROM approvals WHERE state='pending' AND expires_at<?",
      now(),
    )) {
      db.run(
        "UPDATE approvals SET state='expired',version=version+1 WHERE id=?",
        approval.id,
      );
      const agent = db.entity("agents", approval.agent_id);
      s.operation(
        agent.host_id,
        "approval.respond",
        {
          approvalId: approval.id,
          argumentHash: approval.argument_hash,
          expectedVersion: approval.version,
          action: "cancel",
        },
        approval.workspace_id,
        approval.launch_id,
        approval.run_id,
      );
      s.updated("Approval", approval.id, approval.workspace_id);
    }
  });
}
