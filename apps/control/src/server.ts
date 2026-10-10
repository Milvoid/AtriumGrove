import { hostname } from "node:os";
import { browseDirectories } from "./directories.js";
import {
  readAccess,
  verifyPassword,
  checkOrigin,
  configuredOrigin,
} from "./access.js";
import { reconcileHost, maintain } from "./recovery.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { WebSocket } from "ws";
import {
  Store,
  sha,
  uuid,
  now,
  type Row,
} from "../../../packages/persistence/src/index.js";
import { DomainError, invariant } from "../../../packages/domain/src/index.js";
import {
  validate,
  validateFrame,
} from "../../../packages/contracts/src/index.js";
import { Service } from "./service.js";
import { execute } from "./api.js";
import { Scheduler, ingest } from "./runtime.js";
import { collaboration } from "./collaboration.js";
export async function createServer(
  stateDir: string,
  options: { schedule?: boolean; serveWeb?: boolean } = {},
) {
  const store = new Store(join(stateDir, "control", "control.db"));
  const service = new Service(store, stateDir);
  const access = readAccess(stateDir);
  const scheduler = new Scheduler(service);
  const app = Fastify({
    logger: false,
    bodyLimit: 1048576,
    ajv: { customOptions: { strict: false } },
  });
  const hosts = new Map<string, WebSocket>();
  let shuttingDown = false;
  const eventStreams = new Set<import("node:http").ServerResponse>();
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1048576 } });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.setErrorHandler((error, request, reply) => {
    const e = error as DomainError;
    const code = e.code ?? "INTERNAL_ERROR";
    reply.code(e.status ?? (error as any).statusCode ?? 500).send({
      code,
      message:
        (e.status ?? (error as any).statusCode ?? 500) >= 500
          ? "The operation failed; inspect local diagnostics"
          : e.message,
      retryable: false,
      requestId: uuid(),
    });
    if (!e.status && !(error as any).statusCode)
      process.stderr.write(`control: ${String(error)}\n`);
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
    invariant(
      checkOrigin(req.headers.host ?? "", req.headers.origin, access),
      req.headers.origin ? "ORIGIN_DENIED" : "HOST_DENIED",
      "Host or origin is not allowed",
      403,
    );
  });
  const setSession = (
    reply: any,
    host: string,
    result: { session: string; csrf: string },
  ) => {
    const attrs = {
      sameSite: "strict" as const,
      path: "/",
      maxAge: 86400,
      secure: configuredOrigin(host, access)?.startsWith("https://") ?? false,
    };
    reply.setCookie("harbor_session", result.session, {
      ...attrs,
      httpOnly: true,
    });
    reply.setCookie("harbor_csrf", result.csrf, attrs);
    return { authenticated: true, csrfToken: result.csrf };
  };
  app.get("/v1/auth/config", async () => ({ passwordEnabled: !!access }));
  const attempts = new Map<string, { count: number; until: number }>();
  let concurrentLogins = 0;
  app.post("/v1/auth/password", { bodyLimit: 2048 }, async (req, reply) => {
    invariant(
      access,
      "PASSWORD_DISABLED",
      "Password login is not configured",
      404,
    );
    const time = Date.now();
    for (const [ip, attempt] of attempts)
      if (attempt.until <= time) attempts.delete(ip);
    const attempt = attempts.get(req.ip) ?? { count: 0, until: time + 60000 };
    invariant(
      attempt.count < 10 && concurrentLogins < 4 && attempts.size < 10000,
      "LOGIN_RATE_LIMIT",
      "Too many attempts. Try again in one minute.",
      429,
    );
    attempt.count++;
    attempts.set(req.ip, attempt);
    concurrentLogins++;
    try {
      invariant(
        await verifyPassword(access, (req.body as any)?.password),
        "INVALID_LOGIN",
        "密码不正确，请重试",
        401,
      );
      attempts.delete(req.ip);
      return setSession(
        reply,
        req.headers.host ?? "",
        service.auth.exchange(service.auth.nonce()),
      );
    } finally {
      concurrentLogins--;
    }
  });
  app.get("/v1/hosts/:hostId/directories", async (req) => {
    service.auth.session(req.cookies.harbor_session);
    const h = store.entity("hosts", (req.params as Row).hostId);
    invariant(
      h.name === hostname(),
      "REMOTE_DIRECTORY_UNSUPPORTED",
      "此入口只能浏览 Atrium Grove 服务所在电脑",
      400,
    );
    return browseDirectories(
      (req.query as Row).path,
      (req.query as Row).git === "true",
    );
  });
  app.get("/v1/channels/:channelId/members", async (req) => {
    service.auth.session(req.cookies.harbor_session);
    const c = store.entity("channels", (req.params as Row).channelId);
    return {
      channelId: c.id,
      version: c.version,
      agentIds: store
        .all("SELECT agent_id FROM channel_members WHERE channel_id=?", c.id)
        .map((r) => r.agent_id),
    };
  });
  app.get("/v1/channels/:channelId/activity", async (req) => {
    service.auth.session(req.cookies.harbor_session);
    return service.conversationActivity((req.params as Row).channelId);
  });
  const hostAuth = (req: any) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    invariant(bearer, "HOST_AUTH", "Host bearer required", 401);
    const host = store.get(
      "SELECT * FROM hosts WHERE credential_hash=? AND state<>'revoked'",
      sha(bearer),
    );
    invariant(host, "HOST_AUTH", "Host credential rejected", 401);
    return host;
  };
  app.get(
    "/internal/host/v1/connect",
    {
      websocket: true,
      preValidation: async (req) => {
        hostAuth(req);
      },
    },
    (socket, req) => {
      const host = hostAuth(req);
      let welcomed = false;
      socket.on("message", (raw) => {
        if (shuttingDown) return;
        try {
          const f = JSON.parse(raw.toString());
          validateFrame(f);
          if (!welcomed) {
            invariant(
              f.type === "hello" &&
                f.hostId === host.id &&
                f.protocolVersion === "harbor-host.v1",
              "HOST_PROTOCOL",
              "Invalid hello",
            );
            reconcileHost(service, host.id, f.launches as Row[]);
            welcomed = true;
            hosts.get(host.id)?.close();
            hosts.set(host.id, socket);
            service.connectedHosts.add(host.id);
            store.run(
              "UPDATE hosts SET state='online',boot_id=?,last_seen_at=? WHERE id=?",
              String(f.bootId),
              now(),
              host.id,
            );
            socket.send(
              JSON.stringify({
                schemaVersion: 1,
                type: "welcome",
                protocolVersion: "harbor-host.v1",
                controllerEpoch: service.controllerEpoch,
                heartbeatMs: 10000,
                maxBatchEvents: 100,
                maxFrameBytes: 1048576,
              }),
            );
            return;
          }
          store.run(
            "UPDATE hosts SET last_seen_at=? WHERE id=?",
            now(),
            host.id,
          );
          if (f.type === "events_batch") {
            const cursors = new Map<string, number>();
            for (const e of f.events as Row[]) {
              const result = ingest(service, host.id, e);
              cursors.set(e.launchId, result.ack);
            }
            socket.send(
              JSON.stringify({
                schemaVersion: 1,
                type: "events_ack",
                cursors: [...cursors].map(([launchId, producerSeq]) => ({
                  launchId,
                  producerSeq,
                })),
              }),
            );
          } else if (f.type === "command_receipt") {
            const r = f.receipt as Row;
            const command = store.entity("host_commands", r.commandId);
            invariant(
              command.host_id === host.id,
              "SCOPE_DENIED",
              "Receipt host mismatch",
            );
            const envelope = JSON.parse(command.payload_json);
            invariant(
              envelope.payloadHash === r.payloadHash,
              "COMMAND_ID_CONFLICT",
              "Receipt hash mismatch",
            );
            store.tx(() => {
              const state = ["completed", "failed", "unknown"].includes(r.state)
                ? r.state
                : "received";
              store.run(
                "UPDATE host_commands SET state=?,ack_at=? WHERE id=?",
                state,
                now(),
                r.commandId,
              );
              store.run(
                "UPDATE operations SET state=?,result_json=?,error_json=? WHERE id=?",
                state === "received" ? "running" : state,
                r.result ? JSON.stringify(r.result) : null,
                r.error
                  ? JSON.stringify({ ...r.error, requestId: uuid() })
                  : null,
                r.commandId,
              );
              const ws = store.entity("operations", r.commandId).workspace_id;
              if (envelope.kind === "runtime.open") {
                const id = envelope.payload.session.id;
                if (state === "completed") {
                  store.run(
                    "UPDATE agent_sessions SET state=CASE WHEN state='busy' THEN 'busy' ELSE 'ready' END,workspace_path=?,native_session_id=COALESCE(?,native_session_id) WHERE id=?",
                    r.result.workspacePath,
                    r.result.nativeSessionId,
                    id,
                  );
                  store.run(
                    "UPDATE agents SET observed_state='idle' WHERE id=? AND observed_state='starting'",
                    envelope.payload.agent.id,
                  );
                } else if (["failed", "unknown"].includes(state)) {
                  store.run(
                    "UPDATE agent_sessions SET state=? WHERE id=?",
                    state === "failed" ? "failed" : "unknown",
                    id,
                  );
                  store.run(
                    "UPDATE agents SET desired_state='paused',observed_state='degraded' WHERE id=?",
                    envelope.payload.agent.id,
                  );
                }
                if (ws) service.updated("Session", id, ws);
              }
              if (
                envelope.kind === "runtime.close" &&
                r.result?.resourcesQuiescent
              ) {
                const ss = store.get(
                  "SELECT * FROM agent_sessions WHERE launch_id=?",
                  envelope.launchId,
                );
                if (ss) {
                  for (const run of store.all(
                    "SELECT id FROM runs WHERE session_id=? AND state NOT IN ('completed','failed','interrupted')",
                    ss.id,
                  )) {
                    store.run(
                      "UPDATE runs SET state='failed',native_outcome='failed',error_code='PROCESS_CLOSED',ended_at=? WHERE id=?",
                      now(),
                      run.id,
                    );
                    if (ws) service.updated("Run", run.id, ws);
                  }
                  store.run(
                    "UPDATE approvals SET state='cancelled',version=version+1 WHERE launch_id=? AND state='pending'",
                    ss.launch_id,
                  );
                  store.run(
                    "UPDATE agent_sessions SET state='closed',native_session_id=CASE WHEN ? THEN NULL ELSE native_session_id END WHERE id=?",
                    envelope.payload.reset ? 1 : 0,
                    ss.id,
                  );
                  store.run(
                    "UPDATE agents SET observed_state='stopped' WHERE id=?",
                    ss.agent_id,
                  );
                  if (ws) {
                    service.updated("Session", ss.id, ws);
                    service.updated("Agent", ss.agent_id, ws);
                  }
                }
              }
              if (
                envelope.kind === "runtime.close" &&
                ["completed", "failed", "unknown"].includes(state) &&
                !r.result?.resourcesQuiescent
              ) {
                const ss = store.get(
                  "SELECT * FROM agent_sessions WHERE launch_id=?",
                  envelope.launchId,
                );
                if (ss) {
                  store.run(
                    "UPDATE agent_sessions SET state='unknown' WHERE id=?",
                    ss.id,
                  );
                  store.run(
                    "UPDATE agents SET observed_state='unknown',desired_state='paused' WHERE id=?",
                    ss.agent_id,
                  );
                  if (ws) {
                    service.updated("Session", ss.id, ws);
                    service.updated("Agent", ss.agent_id, ws);
                  }
                }
              }
              if (
                envelope.kind === "runtime.submit" &&
                (state === "unknown" || r.result?.status === "unknown")
              )
                store.run(
                  "UPDATE runs SET state='unknown',error_code='SUBMISSION_UNKNOWN' WHERE id=?",
                  envelope.runId,
                );
              if (
                envelope.kind === "runtime.submit" &&
                r.result?.status === "rejected"
              ) {
                const run = store.entity("runs", envelope.runId);
                invariant(
                  !store.get(
                    "SELECT 1 FROM delivery_evidence e JOIN deliveries d ON d.id=e.delivery_id WHERE d.run_id=?",
                    run.id,
                  ),
                  "AMBIGUOUS_REJECTION",
                  "Native rejection conflicts with transport evidence",
                );
                if (
                  store.run(
                    "INSERT OR IGNORE INTO budget_refunds VALUES (?)",
                    run.id,
                  ).changes === 1
                )
                  store.run(
                    "UPDATE episodes SET native_turns_reserved=native_turns_reserved-1 WHERE id=?",
                    run.episode_id,
                  );
                store.run(
                  "UPDATE runs SET state='failed',native_outcome='failed',error_code=?,ended_at=? WHERE id=?",
                  r.result.error.code,
                  now(),
                  run.id,
                );
                store.run(
                  "UPDATE deliveries SET state='pending',reservation_id=NULL,run_id=NULL,error_code=? WHERE run_id=?",
                  r.result.error.code,
                  run.id,
                );
                store.run(
                  "UPDATE agent_sessions SET state='unknown' WHERE id=?",
                  run.session_id,
                );
                store.run(
                  "UPDATE agents SET desired_state='paused',observed_state='degraded' WHERE id=?",
                  run.agent_id,
                );
                if (ws) service.updated("Run", run.id, ws);
              }
              if (ws) service.updated("Operation", r.commandId, ws);
            });
          } else if (f.type === "rpc") {
            let result: any, error: any;
            try {
              const caller = f.caller as any;
              const a = store.entity("agents", caller.agentId);
              invariant(
                a.host_id === host.id,
                "SCOPE_DENIED",
                "Host cannot impersonate another Host",
              );
              result = collaboration(
                service,
                caller,
                String(f.name),
                f.args as Row,
              );
            } catch (e) {
              error = {
                code: (e as any).code ?? "TOOL_ERROR",
                message: String(e),
                retryable: false,
              };
            }
            socket.send(
              JSON.stringify({
                schemaVersion: 1,
                type: "rpc_result",
                id: f.id,
                result,
                error,
              }),
            );
          } else if (f.type === "inventory") {
            store.run(
              "UPDATE hosts SET inventory_json=? WHERE id=?",
              JSON.stringify(f.entries),
              host.id,
            );
          } else if (f.type === "resource_snapshot") {
            const r = f.resource as Row;
            store.run(
              "INSERT INTO resource_projections(host_id,resource_id,provider,qualified,state,lease_epoch,owner_run_id,in_flight_calls,diagnostic) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(host_id,resource_id) DO UPDATE SET provider=excluded.provider,qualified=excluded.qualified,state=excluded.state,lease_epoch=excluded.lease_epoch,owner_run_id=excluded.owner_run_id,in_flight_calls=excluded.in_flight_calls,diagnostic=excluded.diagnostic",
              host.id,
              r.resource_id,
              r.provider,
              r.state === "unavailable" ? 0 : 1,
              r.state,
              r.lease_epoch,
              r.owner_run_id,
              r.pending_calls,
              r.diagnostic,
            );
          }
        } catch (e) {
          const code = (e as any).code;
          if (code === "EVENT_GAP")
            socket.send(JSON.stringify({ schemaVersion: 1, type: "gap" }));
          else {
            process.stderr.write("Host frame rejected: " + String(e) + "\n");
            if (code === "PRODUCER_CONFLICT") {
              store.run(
                "UPDATE hosts SET state='degraded' WHERE id=?",
                host.id,
              );
              socket.close();
            }
          }
        }
      });
      socket.on("close", () => {
        if (shuttingDown) return;
        if (hosts.get(host.id) === socket) {
          hosts.delete(host.id);
          service.connectedHosts.delete(host.id);
          store.run("UPDATE hosts SET state='offline' WHERE id=?", host.id);
        }
      });
    },
  );
  app.post(
    "/internal/host/v1/artifacts",
    { bodyLimit: 25 * 1024 * 1024 },
    async (req) => {
      const host = hostAuth(req);
      const session = store.get(
        "SELECT * FROM agent_sessions WHERE launch_id=?",
        String(req.headers["x-launch-id"]),
      );
      invariant(session, "STALE_LAUNCH", "Unknown launch");
      const agent = store.entity("agents", session.agent_id),
        run = store.entity("runs", String(req.headers["x-run-id"]));
      invariant(
        agent.host_id === host.id &&
          run.agent_id === agent.id &&
          run.launch_id === session.launch_id &&
          JSON.parse(agent.capabilities_json).includes(
            req.headers["x-computer-observation"] === "true" &&
              req.headers["x-artifact-kind"] === "image"
              ? "desktop.request"
              : "artifact.register",
          ) &&
          !["completed", "failed", "interrupted"].includes(run.state),
        "SCOPE_DENIED",
        "Artifact caller mismatch",
      );
      const bytes = req.body as Buffer;
      const filename = decodeURIComponent(String(req.headers["x-filename"])),
        kind = String(req.headers["x-artifact-kind"]);
      invariant(
        ["file", "image", "diff", "test_report", "log"].includes(kind),
        "INVALID_KIND",
        "Invalid artifact kind",
      );
      const staged = service.artifacts.stage(bytes, filename);
      return service.mutate(
        agent.id,
        "artifact_register",
        String(req.headers["idempotency-key"] ?? ""),
        { sha256: sha(bytes), filename, kind },
        () => {
          const id = service.artifacts.record(
            agent.workspace_id,
            agent.id,
            staged,
            kind,
          );
          return service.updated(
            "Artifact",
            id,
            agent.workspace_id,
            agent.id,
            "artifact.created",
          );
        },
      );
    },
  );
  const api = parse(
    readFileSync(
      new URL("../../../spec/contracts/openapi.yaml", import.meta.url),
      "utf8",
    ),
  );
  for (const [path, methods] of Object.entries(api.paths) as Array<
    [string, Row]
  >)
    for (const [method, definition] of Object.entries(methods) as Array<
      [string, Row]
    >) {
      const url = path.replace(/\{([^}]+)\}/g, ":$1"),
        op = definition.operationId;
      app.route({
        url,
        method: method.toUpperCase() as any,
        bodyLimit: op === "uploadArtifact" ? 25 * 1024 * 1024 : 1048576,
        handler: async (req, reply) => {
          const p = req.params as Row,
            q = req.query as Row,
            b = (req.body ?? {}) as Row;
          const mutation = method !== "get";
          if (op === "health") return execute(service, op, p, b, q);
          if (op === "exchangeLogin") {
            validate("Login", b);
            const result = service.auth.exchange(b.oneTimeToken);
            return setSession(reply, req.headers.host ?? "", result);
          }
          const token = req.cookies.harbor_session;
          service.auth.session(
            token,
            mutation ? String(req.headers["x-csrf-token"] ?? "") : undefined,
          );
          if (op === "logout") {
            service.auth.logout(token!);
            reply.clearCookie("harbor_session", { path: "/" });
            reply.clearCookie("harbor_csrf", { path: "/" });
            return { authenticated: false, csrfToken: "" };
          }
          if (op === "events") {
            let after = String(q.after ?? "0");
            const last = req.headers["last-event-id"];
            if (last) {
              invariant(
                /^\d+$/.test(String(last)),
                "INVALID_CURSOR",
                "Invalid Last-Event-ID",
                400,
              );
              if (BigInt(String(last)) > BigInt(after)) after = String(last);
            }
            service.events(p.workspaceId, after);
            reply.hijack();
            eventStreams.add(reply.raw);
            reply.raw.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            // Establish the stream immediately, even when there are no new events.
            reply.raw.write(": connected\n\n");
            let stopped = false;
            let ticks = 0;
            const timer = setInterval(() => {
              if (stopped) return;
              try {
                service.auth.session(token);
                for (const event of service.events(p.workspaceId, after)) {
                  const ready = reply.raw.write(
                    `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                  );
                  after = event.seq;
                  if (!ready) break;
                }
                if (++ticks % 60 === 0) reply.raw.write(": heartbeat\n\n");
              } catch {
                reply.raw.end();
                clearInterval(timer);
              }
            }, 250);
            reply.raw.on("close", () => {
              eventStreams.delete(reply.raw);
              stopped = true;
              clearInterval(timer);
            });
            return;
          }
          if (op === "artifactContent") {
            const artifact = store.entity("artifacts", p.artifactId);
            const { bytes } = service.artifacts.read(
              p.artifactId,
              artifact.workspace_id,
              "owner",
            );
            reply
              .header(
                "Content-Type",
                artifact.mime_type.startsWith("image/")
                  ? artifact.mime_type
                  : "application/octet-stream",
              )
              .header(
                "Content-Disposition",
                `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
              );
            return reply.send(bytes);
          }
          if (op === "uploadArtifact") {
            const bytes = req.body as Buffer,
              filename = decodeURIComponent(
                String(req.headers["x-filename"] ?? ""),
              );
            const staged = service.artifacts.stage(bytes, filename);
            const result = service.mutate(
              service.auth.owner,
              path + ":" + p.workspaceId,
              String(req.headers["idempotency-key"] ?? ""),
              { filename, sha256: sha(bytes), workspace: p.workspaceId },
              () => {
                service.workspace(p.workspaceId);
                const id = service.artifacts.record(
                  p.workspaceId,
                  service.auth.owner,
                  staged,
                );
                return service.updated(
                  "Artifact",
                  id,
                  p.workspaceId,
                  service.auth.owner,
                  "artifact.created",
                );
              },
            );
            return reply.code(201).send(result);
          }
          const schema = definition.requestBody?.content?.[
            "application/json"
          ]?.schema?.$ref
            ?.split("/")
            .at(-1);
          if (schema) validate(schema, b);
          const result = mutation
            ? service.mutate(
                service.auth.owner,
                method + ":" + req.url.split("?")[0],
                String(req.headers["idempotency-key"] ?? ""),
                b,
                () => execute(service, op, p, b, q),
              )
            : execute(service, op, p, b, q);
          const success = Object.keys(definition.responses).find((c) =>
            c.startsWith("2"),
          )!;
          return reply.code(Number(success)).send(result);
        },
      });
    }
  // Preserve the session CSRF value across reloads and concurrent tabs.
  app.get("/v1/auth/session", async (req) => {
    const row = service.auth.session(req.cookies.harbor_session);
    const csrf = req.cookies.harbor_csrf;
    invariant(
      csrf && sha(csrf) === row.csrf_hash,
      "CSRF_INVALID",
      "Refresh login to restore CSRF cookie",
      401,
    );
    return { authenticated: true, csrfToken: csrf };
  });
  const webRoot = resolve("apps/web/dist");
  if (options.serveWeb !== false && existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, prefix: "/" });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/v1/")
        ? reply.code(404).send({
            code: "NOT_FOUND",
            message: "Route not found",
            retryable: false,
            requestId: uuid(),
          })
        : reply.sendFile("index.html"),
    );
  }
  const outbox = setInterval(() => {
    for (const c of store.all(
      "SELECT * FROM host_commands WHERE state IN ('pending','sent') AND not_before_ms<=? LIMIT 100",
      Date.now(),
    )) {
      const host = hosts.get(c.host_id);
      if (!host) continue;
      host.send(
        JSON.stringify({
          schemaVersion: 1,
          type: "command",
          command: JSON.parse(c.payload_json),
        }),
      );
      store.run(
        "UPDATE host_commands SET state='sent',attempt=attempt+1,not_before_ms=? WHERE id=?",
        Date.now() + 2000,
        c.id,
      );
    }
  }, 250);
  const heartbeat = setInterval(() => {
    maintain(service);
    for (const [hostId, socket] of hosts) {
      const h = store.entity("hosts", hostId);
      if (Date.now() - Date.parse(h.last_seen_at) > 30000) socket.terminate();
    }
    for (const ws of hosts.values())
      ws.send(JSON.stringify({ schemaVersion: 1, type: "ping" }));
  }, 10000);
  if (options.schedule !== false) scheduler.start();
  app.addHook("preClose", async () => {
    shuttingDown = true;
    scheduler.stop();
    for (const response of eventStreams) response.end();
    for (const socket of hosts.values()) socket.terminate();
  });
  app.addHook("onClose", async () => {
    shuttingDown = true;
    scheduler.stop();
    clearInterval(outbox);
    clearInterval(heartbeat);
    for (const ws of hosts.values()) ws.close();
    store.close();
  });
  return { app, service, scheduler, store };
}
