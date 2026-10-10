import { tracePreview } from "../../../packages/runtime-common/src/telemetry.js";
import { computerUseAllowed } from "../../../packages/runtime-common/src/permissions.js";
import {
  executablePath,
  processIdentity,
  processGroupAlive,
  stopOwnedProcess,
} from "../../../packages/runtime-common/src/index.js";
import { WebSocket } from "ws";
import { createServer, type Server as NetServer } from "node:net";
import {
  mkdirSync,
  chmodSync,
  unlinkSync,
  readFileSync,
  realpathSync,
  existsSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  Store,
  uuid,
  now,
  sha,
  canonical,
  equalSecret,
  type Row,
} from "../../../packages/persistence/src/index.js";
import { invariant } from "../../../packages/domain/src/index.js";
import {
  toolSchema,
  toolCapability,
  validateFrame,
} from "../../../packages/contracts/src/index.js";
import { safePath } from "../../../packages/artifacts/src/index.js";
import {
  verifyProject,
  verifyDirectory,
  prepareWorkspace,
  initializeGit,
} from "../../../packages/worktrees/src/index.js";
import { CodexSession } from "../../../packages/runtime-codex/src/index.js";
import { ClaudeSession } from "../../../packages/runtime-claude/src/index.js";
import { FakeSession } from "../../../packages/runtime-testkit/src/index.js";
import { ComputerGateway } from "../../../packages/computer-gateway/src/index.js";
import {
  LcuProvider,
  type LcuConfig,
} from "../../../packages/computer-lcu/src/index.js";
import type {
  HarnessSession,
  SessionSpec,
  RuntimeEvent,
  HumanDecision,
  DesktopContext,
} from "../../../spec/contracts/runtime.js";
export interface HostConfig {
  hostId: string;
  credential: string;
  controllerUrl: string;
  stateDir: string;
  mode: "native" | "fake";
  codexPath: string;
  claudePath: string;
  lcu?: LcuConfig;
}
export class Host {
  readonly db: Store;
  readonly bootId = uuid();
  readonly gateway: ComputerGateway;
  private desktopApprovals = new Map<string, (d: HumanDecision) => void>();
  private desktopContexts = new Map<string, DesktopContext>();
  private ws?: WebSocket;
  private epoch = "";
  private stopped = false;
  private broker?: NetServer;
  private interval?: NodeJS.Timeout;
  private sessions = new Map<
    string,
    {
      session: HarnessSession;
      agent: Row;
      token: string;
      desktopToken: string;
      abort?: AbortController;
      runId: string | null;
    }
  >();
  private requests = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly socketPath: string;
  private lockFd?: number;
  constructor(readonly config: HostConfig) {
    mkdirSync(join(config.stateDir, "host"), { recursive: true, mode: 0o700 });
    this.db = new Store(join(config.stateDir, "host", "host.db"), "host");
    this.socketPath = join(config.stateDir, "host", "broker.sock");
    this.gateway = new ComputerGateway(
      this.db,
      `desktop:${config.hostId}:console`,
      config.lcu ? new LcuProvider(config.lcu) : null,
    );
  }
  async start() {
    const lock = join(this.config.stateDir, "host", "host.lock");
    if (existsSync(lock)) {
      try {
        const old = JSON.parse(readFileSync(lock, "utf8"));
        if (
          old.pid &&
          old.startedAt &&
          processIdentity(old.pid) !== old.startedAt
        )
          unlinkSync(lock);
      } catch {}
    }

    try {
      this.lockFd = openSync(lock, "wx", 0o600);
      writeFileSync(
        this.lockFd,
        JSON.stringify({
          pid: process.pid,
          startedAt: processIdentity(process.pid),
        }),
      );
    } catch {
      throw new Error(
        "Host lock exists; verify and remove only after the old Host has stopped",
      );
    }
    this.db.run(
      "UPDATE received_commands SET state='unknown' WHERE state IN ('issuing','received')",
    );
    this.db.run(
      "UPDATE launches SET state='unknown' WHERE state NOT IN ('closed','exited','failed')",
    );
    // An idle, confirmed-dead process can be reopened without repeating a turn.
    for (const launch of this.db.all(
      "SELECT * FROM launches WHERE state='unknown' AND current_run_id IS NULL",
    )) {
      if (
        launch.pid &&
        !processGroupAlive(launch.pid) &&
        processIdentity(launch.pid) !== launch.pid_started_at
      )
        this.db.run(
          "UPDATE launches SET state='closed' WHERE launch_id=?",
          launch.launch_id,
        );
    }
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    this.broker = createServer((socket) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
        if (Buffer.byteLength(text) > 1048576) {
          socket.destroy();
          return;
        }
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        socket.pause();
        void (async () => {
          try {
            const request = JSON.parse(text.slice(0, newline));
            const entry = [...this.sessions.values()].find(
              (s) =>
                equalSecret(s.token, request.token ?? "") ||
                equalSecret(s.desktopToken, request.token ?? ""),
            );
            invariant(entry, "STALE_LAUNCH", "Invalid relay token", 403);
            const result = await this.tool(
              entry,
              request.name,
              request.args,
              equalSecret(entry.desktopToken, request.token ?? ""),
            );
            socket.end(JSON.stringify({ result }) + "\n");
          } catch (e) {
            socket.end(
              JSON.stringify({ error: { message: String(e) } }) + "\n",
            );
          }
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.broker!.once("error", failed);
      this.broker!.listen(this.socketPath, () => {
        this.broker!.off("error", failed);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
    if (this.config.lcu?.qualification) {
      try {
        await this.gateway.qualify(
          this.config.lcu.qualification.humanControlHostExcluded,
        );
      } catch (e) {
        this.db.run(
          "UPDATE desktop_resources SET state='unavailable',diagnostic=? WHERE state<>'quarantined'",
          String(e),
        );
      }
    }
    this.connect();
    this.interval = setInterval(() => this.flush(), 1000);
  }
  private send(frame: Row) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ schemaVersion: 1, ...frame }));
  }
  private connect() {
    if (this.stopped) return;
    this.ws = new WebSocket(
      this.config.controllerUrl.replace(/^http/, "ws") +
        "/internal/host/v1/connect",
      {
        headers: { Authorization: "Bearer " + this.config.credential },
        maxPayload: 1048576,
      },
    );
    this.ws.on("open", () =>
      this.send({
        type: "hello",
        hostId: this.config.hostId,
        bootId: this.bootId,
        protocolVersion: "harbor-host.v1",
        launches: this.db.all(
          "SELECT launch_id AS launchId,session_id AS sessionId,current_run_id AS runId,native_session_id AS nativeSessionId,state FROM launches",
        ),
        spoolCursors: this.db
          .all("SELECT key,value FROM harbor_meta WHERE key LIKE 'seq:%'")
          .map((r) => ({
            launchId: r.key.slice(4),
            lastProducedSeq: Number(r.value),
            lastAckedSeq: Number(this.db.meta("ack:" + r.key.slice(4)) ?? 0),
          })),
      }),
    );
    this.ws.on("message", (data) => {
      void (async () => this.receive(JSON.parse(data.toString())))().catch(
        (e) => process.stderr.write("host protocol: " + String(e) + "\n"),
      );
    });
    this.ws.on("error", () => {});
    this.ws.on("close", () => {
      this.epoch = "";
      if (!this.stopped) setTimeout(() => this.connect(), 1000);
    });
  }
  private async receive(frame: Row) {
    if (this.stopped) return;
    validateFrame(frame);
    switch (frame.type) {
      case "welcome":
        this.epoch = String(frame.controllerEpoch);
        this.send({ type: "inventory", entries: this.inventory() });
        this.flush();
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "command":
        await this.command(frame.command as Row);
        break;
      case "events_ack":
        for (const ack of frame.cursors as Row[]) {
          this.db.tx(() => {
            this.db.run(
              "DELETE FROM event_spool WHERE launch_id=? AND producer_seq<=?",
              ack.launchId,
              ack.producerSeq,
            );
            this.db.setMeta("ack:" + ack.launchId, String(ack.producerSeq));
          });
        }
        break;
      case "rpc_result": {
        const p = this.requests.get(String(frame.id));
        if (p) {
          clearTimeout(p.timer);
          this.requests.delete(String(frame.id));
          frame.error
            ? p.reject(new Error(JSON.stringify(frame.error)))
            : p.resolve(frame.result);
        }
        break;
      }
      case "gap":
        this.flush();
        break;
    }
  }
  private rpc(caller: Row, name: string, args: Row): Promise<any> {
    invariant(this.epoch, "HOST_OFFLINE", "Control plane disconnected");
    return new Promise((resolve, reject) => {
      const id = uuid(),
        timer = setTimeout(() => {
          this.requests.delete(id);
          reject(new Error("Control plane request timed out"));
        }, 30000);
      this.requests.set(id, { resolve, reject, timer });
      this.send({ type: "rpc", id, caller, name, args });
    });
  }
  private caller(entry: {
    session: HarnessSession;
    agent: Row;
    runId: string | null;
  }) {
    invariant(entry.runId, "NO_ACTIVE_RUN", "No active run");
    return {
      workspaceId: entry.agent.workspaceId,
      agentId: entry.agent.id,
      sessionId: entry.session.spec.sessionId,
      launchId: entry.session.spec.launchId,
      runId: entry.runId,
      capabilities: entry.agent.capabilities,
      channelIds: [],
    };
  }
  private async tool(
    entry: {
      session: HarnessSession;
      agent: Row;
      token: string;
      runId: string | null;
    },
    name: string,
    args: Row,
    computer = false,
  ) {
    const computerAllowed = computerUseAllowed(
      entry.session.spec.permissionProfile,
      entry.agent.capabilities,
    );
    if (computer)
      invariant(
        computerAllowed,
        "CAPABILITY_DENIED",
        "Enable Computer Use for this member",
        403,
      );
    if (name === "tools/list") {
      if (computer)
        return this.gateway.provider instanceof LcuProvider
          ? this.gateway.provider.publicTools
          : [];
      const tools = Object.entries(toolSchema.$defs)
        .filter(([n]) => entry.agent.capabilities.includes(toolCapability[n]))
        .map(([n, schema]) => ({
          name: n,
          description: `Atrium Grove ${n}`,
          inputSchema: schema,
        }));
      return tools;
    }
    invariant(
      computer === ["js", "js_reset"].includes(name),
      "CAPABILITY_DENIED",
      "Tool belongs to a different relay",
      403,
    );
    const caller = this.caller(entry);
    if (name === "js" || name === "js_reset") {
      invariant(
        computerAllowed,
        "CAPABILITY_DENIED",
        "Computer Use is not enabled",
      );
      const callId = "computer:" + uuid();
      const event = { ...caller, lane: [], occurredAt: now() };
      this.spool({
        ...event,
        kind: "tool.started",
        callId,
        name: "computer",
        input: {
          ...args,
          title:
            args.title ??
            (name === "js_reset" ? "重置电脑操作会话" : "操作电脑"),
        },
      });
      try {
        const context = await this.gateway.acquire(
          {
            workspaceId: caller.workspaceId,
            agentId: caller.agentId,
            launchId: caller.launchId,
            runId: caller.runId,
            hostSessionId: caller.sessionId,
            hostTurnId: caller.runId,
            resourceId: this.gateway.resourceId,
          },
          (request) =>
            new Promise<HumanDecision>((resolve) => {
              const cancel = () => {
                this.desktopApprovals.delete(request.approvalId);
                resolve({
                  approvalId: request.approvalId,
                  argumentHash: request.argumentHash,
                  expectedVersion: 0,
                  action: "cancel",
                });
              };
              const abort = this.sessions.get(caller.launchId)?.abort?.signal;
              if (abort?.aborted) {
                cancel();
                return;
              }
              abort?.addEventListener("abort", cancel, { once: true });
              this.desktopApprovals.set(request.approvalId, (decision) => {
                abort?.removeEventListener("abort", cancel);
                resolve(decision);
              });
              this.spool({
                ...caller,
                producerSeq: 0,
                kind: "approval.requested",
                request,
                lane: [],
                occurredAt: now(),
              });
            }),
          { signal: this.sessions.get(caller.launchId)?.abort?.signal },
        );
        this.desktopContexts.set(caller.runId, context);
        const result = await this.gateway.call(name, args, context);
        const observations = await this.recordComputerImages(
          result.content,
          caller,
          context,
          callId,
        );
        this.spool({
          ...event,
          occurredAt: now(),
          kind: "tool.completed",
          callId,
          outcome: result.isError ? "error" : "ok",
          result: {
            observations,
            content: tracePreview(
              result.content.filter((b) => b.type === "text"),
            ),
          },
        });
        return result;
      } catch (error) {
        this.spool({
          ...event,
          occurredAt: now(),
          kind: "tool.completed",
          callId,
          outcome: "error",
          result: { message: String(error) },
        });
        throw error;
      }
    }
    if (name === "artifact_register") {
      invariant(
        entry.agent.capabilities.includes("artifact.register"),
        "CAPABILITY_DENIED",
        "Artifact registration denied",
      );
      const path = safePath(entry.session.spec.workspacePath, args.localPath),
        bytes = readFileSync(path);
      invariant(
        bytes.length <= 25 * 1024 * 1024,
        "ARTIFACT_TOO_LARGE",
        "Artifact too large",
      );
      const response = await fetch(
        this.config.controllerUrl + "/internal/host/v1/artifacts",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.config.credential,
            "Content-Type": "application/octet-stream",
            "X-Launch-Id": caller.launchId,
            "X-Run-Id": caller.runId,
            "X-Filename": encodeURIComponent(args.filename),
            "X-Artifact-Kind": args.kind,
            "Idempotency-Key": args.requestKey,
          },
          body: bytes,
        },
      );
      if (!response.ok) throw new Error(await response.text());
      return {
        content: [
          { type: "text", text: JSON.stringify(await response.json()) },
        ],
      };
    }
    return this.rpc(caller, name, args);
  }
  private async recordComputerImages(
    content: any[],
    caller: Row,
    context: DesktopContext,
    callId: string,
  ) {
    const observations: Row[] = [];
    for (const [index, block] of content.entries()) {
      if (block.type !== "image" || typeof block.data !== "string") continue;
      const capturedAt = now(),
        bytes = Buffer.from(block.data, "base64");
      const metadata = {
        provider: this.gateway.provider!.id,
        connectionId: `${context.resourceId}:${context.leaseEpoch}`,
        providerSessionId: context.hostSessionId,
        hostTurnId: context.hostTurnId,
        runId: context.runId,
        leaseEpoch: context.leaseEpoch,
        capturedAt,
        sha256: sha(bytes),
      };
      try {
        const response = await fetch(
          this.config.controllerUrl + "/internal/host/v1/artifacts",
          {
            method: "POST",
            signal: AbortSignal.timeout(15000),
            headers: {
              Authorization: "Bearer " + this.config.credential,
              "Content-Type": "application/octet-stream",
              "X-Launch-Id": caller.launchId,
              "X-Run-Id": caller.runId,
              "X-Filename": `computer-${context.leaseEpoch}-${index}.${block.mimeType === "image/jpeg" ? "jpg" : "png"}`,
              "X-Artifact-Kind": "image",
              "X-Computer-Observation": "true",
              "Idempotency-Key": callId + ":" + index,
            },
            body: bytes,
          },
        );
        if (!response.ok)
          throw new Error(`Screenshot storage failed (${response.status})`);
        const artifact = (await response.json()) as Row;
        observations.push({ ...metadata, artifactId: artifact.id });
      } catch (error) {
        observations.push({ ...metadata, error: String(error) });
      }
    }
    return observations;
  }
  private async command(command: Row) {
    const old = this.db.get(
      "SELECT * FROM received_commands WHERE command_id=?",
      command.commandId,
    );
    if (old) {
      invariant(
        old.command_hash === command.payloadHash,
        "COMMAND_ID_CONFLICT",
        "Command payload changed",
      );
      this.send({
        type: "command_receipt",
        receipt: JSON.parse(
          old.response_json ??
            JSON.stringify({
              commandId: command.commandId,
              payloadHash: command.payloadHash,
              state: old.state,
            }),
        ),
      });
      return;
    }
    invariant(
      command.hostId === this.config.hostId &&
        command.controllerEpoch === this.epoch &&
        command.expiresAt > now() &&
        sha(canonical(command.payload)) === command.payloadHash,
      "INVALID_COMMAND",
      "Command binding invalid",
    );
    this.db.run(
      "INSERT INTO received_commands(command_id,command_hash,state,payload_json,launch_id,received_at) VALUES (?,?,'received',?,?,?)",
      command.commandId,
      command.payloadHash,
      JSON.stringify(command),
      command.launchId ?? null,
      now(),
    );
    this.db.run(
      "UPDATE received_commands SET state='issuing' WHERE command_id=?",
      command.commandId,
    );
    let receipt: Row;
    try {
      const result = await this.execute(command);
      receipt = {
        commandId: command.commandId,
        payloadHash: command.payloadHash,
        state: result?.status === "unknown" ? "unknown" : "completed",
        result,
      };
    } catch (e) {
      receipt = {
        commandId: command.commandId,
        payloadHash: command.payloadHash,
        state: command.kind === "runtime.submit" ? "unknown" : "failed",
        error: {
          code: (e as any).code ?? "HOST_ERROR",
          message: String(e),
          retryable: false,
        },
      };
    }
    this.db.run(
      "UPDATE received_commands SET state=?,response_json=? WHERE command_id=?",
      receipt.state,
      JSON.stringify(receipt),
      command.commandId,
    );
    this.send({ type: "command_receipt", receipt });
  }
  private async execute(c: Row): Promise<any> {
    const p = c.payload,
      entry = this.sessions.get(c.launchId);
    switch (c.kind) {
      case "host.probe": {
        const entries = this.inventory();
        this.send({ type: "inventory", entries });
        return { entries };
      }
      case "project.verify":
        return p.workspaceMode === "directory"
          ? verifyDirectory(p.rootPath)
          : verifyProject(p.rootPath, p.baseRef);
      case "project.git.initialize":
        return initializeGit(p.rootPath);
      case "runtime.open": {
        const a = p.agent,
          session = p.session;
        const path = await prepareWorkspace(
          this.config.stateDir,
          a.workspaceId,
          session.channelId ? `${a.id}/${session.channelId}` : a.id,
          session.generation,
          {
            ...p.project,
            workspaceMode: p.project.workspaceMode ?? "git-worktree",
          },
        );
        const binary =
          this.config.mode === "fake"
            ? process.execPath
            : executablePath(
                a.runtime.driver === "codex-app-server"
                  ? this.config.codexPath
                  : this.config.claudePath,
              );
        const token = uuid() + uuid(),
          desktopToken = uuid() + uuid();
        const relay = fileURLToPath(
          new URL("../../../packages/mcp-relay/src/main.ts", import.meta.url),
        );
        const tsx = fileURLToPath(
          new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url),
        );
        const spec: SessionSpec = {
          agentId: a.id,
          sessionId: session.id,
          launchId: c.launchId,
          generation: session.generation,
          driver: a.runtime.driver,
          executable: {
            id: a.runtime.executableProfile,
            realPath: binary,
            sha256: sha(readFileSync(binary)),
            version: execFileSync(binary, ["--version"], {
              encoding: "utf8",
            }).trim(),
            authProfileRef: a.runtime.settingsProfile,
          },
          workspacePath: path,
          model: a.runtime.model,
          effort: a.runtime.effort,
          permissionProfile: a.runtime.permissionProfile,
          settingsProfile: a.runtime.settingsProfile,
          diagnosticDir: join(
            this.config.stateDir,
            "host",
            "diagnostics",
            c.launchId,
          ),
          standingInstructions:
            readFileSync(
              new URL(
                "../../../spec/prompts/standing-instructions.md",
                import.meta.url,
              ),
              "utf8",
            )
              .replaceAll("{{agentName}}", a.name)
              .replaceAll("{{agentId}}", a.id)
              .replaceAll("{{workspaceName}}", a.workspaceId)
              .replaceAll("{{roleDescription}}", a.role) +
            `\nWorking directory: ${path}\nWorkspace mode: ${p.project.workspaceMode === "directory" ? "shared folder; do not initialize Git or create worktrees automatically" : "isolated Git worktree"}.`,
          mcpServers: [
            {
              name: "harbor",
              command: process.execPath,
              args: ["--import", tsx, relay],
              env: {
                HARBOR_SOCKET: this.socketPath,
                HARBOR_RELAY_TOKEN: token,
              },
            },
          ],
          ...(session.nativeSessionId
            ? { nativeResumeId: session.nativeSessionId }
            : {}),
        };
        if (computerUseAllowed(spec.permissionProfile, a.capabilities)) {
          invariant(
            this.gateway.state().state !== "unavailable" &&
              this.gateway.provider instanceof LcuProvider,
            "PROVIDER_UNQUALIFIED",
            "Computer Use requires a qualified provider. Open 执行电脑 to check setup.",
          );
          spec.mcpServers.push({
            name: "harbor_computer",
            command: process.execPath,
            args: ["--import", tsx, relay],
            env: {
              HARBOR_SOCKET: this.socketPath,
              HARBOR_RELAY_TOKEN: desktopToken,
              HARBOR_RELAY_NAME: "harbor_computer",
            },
          });
          spec.standingInstructions +=
            "\n\n" + this.gateway.provider.instructions;
        }
        const emit = async (e: RuntimeEvent) => {
          if (e.kind === "session.ready" && "nativeModel" in runtime)
            this.db.setMeta(
              "model:" + c.launchId,
              String(runtime.nativeModel ?? "unknown"),
            );
          this.spool(e);
          if (e.kind === "turn.terminal" && !e.lane.length) {
            const quiescent = await this.gateway.drain(
              e.runId!,
              e.outcome === "interrupted" ? "Interrupted" : "Stop",
            );
            if (quiescent)
              this.spool({ ...e, kind: "resources.quiescent" } as any);
            const active = this.sessions.get(c.launchId);
            if (active) {
              active.abort?.abort();
              active.runId = null;
            }
            this.desktopContexts.delete(e.runId!);
            this.db.run(
              "UPDATE launches SET state='ready',current_run_id=NULL WHERE launch_id=?",
              c.launchId,
            );
          }
        };
        const runtime =
          this.config.mode === "fake"
            ? new FakeSession(spec, emit, (name, args) =>
                this.tool(this.sessions.get(c.launchId)!, name, args),
              )
            : a.runtime.driver === "codex-app-server"
              ? new CodexSession(spec, emit)
              : new ClaudeSession(spec, emit);
        this.sessions.set(c.launchId, {
          session: runtime,
          agent: a,
          token,
          desktopToken,
          runId: null,
        });
        this.db.run(
          "INSERT INTO launches(launch_id,agent_id,session_id,native_session_id,driver,state,executable_realpath,executable_digest,credential_hash,created_at) VALUES (?,?,?,?,?,'opening',?,?,?,?)",
          c.launchId,
          a.id,
          session.id,
          session.nativeSessionId,
          a.runtime.driver,
          binary,
          spec.executable.sha256,
          sha(token),
          now(),
        );
        const initializing = runtime.initialize();
        if ("processId" in runtime && runtime.processId)
          this.db.run(
            "UPDATE launches SET pid=?,pid_started_at=? WHERE launch_id=?",
            runtime.processId,
            processIdentity(runtime.processId),
            c.launchId,
          );
        try {
          await initializing;
        } catch (error) {
          const receipt = await (runtime as HarnessSession).close(
            "shutdown",
            AbortSignal.timeout(10000),
          );
          this.db.run(
            "UPDATE launches SET state=? WHERE launch_id=?",
            receipt.resourcesQuiescent ? "failed" : "unknown",
            c.launchId,
          );
          if (receipt.resourcesQuiescent) this.sessions.delete(c.launchId);
          if (!receipt.resourcesQuiescent)
            return { status: "unknown", reason: String(error) };
          throw error;
        }
        this.db.run(
          "UPDATE launches SET state='ready',native_session_id=? WHERE launch_id=?",
          runtime.nativeSessionId,
          c.launchId,
        );
        return {
          sessionId: session.id,
          nativeSessionId: runtime.nativeSessionId,
          workspacePath: path,
        };
      }
      case "runtime.submit":
        invariant(entry, "STALE_LAUNCH", "Unknown launch");
        invariant(
          this.db.get(
            "SELECT coalesce(sum(length(event_json)),0) n FROM event_spool",
          )!.n <
            64 * 1024 * 1024,
          "SPOOL_FULL",
          "Host spool requires acknowledgement before accepting work",
        );
        entry.abort = new AbortController();
        entry.runId = p.runId;
        this.db.run(
          "UPDATE launches SET current_run_id=?,state='busy' WHERE launch_id=?",
          p.runId,
          c.launchId,
        );
        return entry.session.submit(p, AbortSignal.timeout(60000));
      case "runtime.steer":
        invariant(entry, "STALE_LAUNCH", "Unknown launch");
        return entry.session.steer(
          { ...p, inputId: p.clientMessageId, text: p.text },
          AbortSignal.timeout(60000),
        );
      case "runtime.interrupt":
        invariant(entry, "STALE_LAUNCH", "Unknown launch");
        entry.abort?.abort();
        this.gateway.stop(p.runId);
        return entry.session.interrupt(p.runId, AbortSignal.timeout(30000));
      case "runtime.reconcile":
        invariant(entry, "STALE_LAUNCH", "Lost original process control");
        return entry.session.reconcile(AbortSignal.timeout(10000));
      case "runtime.close": {
        if (!entry) {
          const launch = this.db.get(
            "SELECT * FROM launches WHERE launch_id=?",
            c.launchId,
          );
          const stopped = launch?.pid
            ? await stopOwnedProcess(
                launch.pid,
                launch.pid_started_at,
                AbortSignal.timeout(10000),
              )
            : !!launch && ["closed", "exited", "failed"].includes(launch.state);
          const desktop = this.gateway.state();
          const quiescent = stopped && desktop.owner_launch_id !== c.launchId;
          if (quiescent)
            this.db.run(
              "UPDATE launches SET state='closed',current_run_id=NULL WHERE launch_id=?",
              c.launchId,
            );
          return {
            requestAccepted: !!launch,
            terminalConfirmed: stopped,
            resourcesQuiescent: quiescent,
          };
        }
        entry.abort?.abort();
        if (entry.runId) this.gateway.stop(entry.runId);
        const result = await entry.session.close(
          p.reason,
          AbortSignal.timeout(10000),
        );
        if (entry.runId && result.resourcesQuiescent)
          result.resourcesQuiescent = await this.gateway.drain(
            entry.runId,
            "Shutdown",
          );
        if (result.resourcesQuiescent) {
          this.sessions.delete(c.launchId);
          this.db.run(
            "UPDATE launches SET state='closed',current_run_id=NULL WHERE launch_id=?",
            c.launchId,
          );
        }
        return result;
      }
      case "approval.respond":
        invariant(entry, "STALE_APPROVAL", "Launch closed");
        {
          const pending = this.db.get(
            "SELECT * FROM pending_approvals WHERE approval_id=?",
            p.approvalId,
          );
          invariant(
            pending?.state === "pending" &&
              pending.launch_id === c.launchId &&
              pending.run_id === entry.runId &&
              pending.argument_hash === p.argumentHash,
            "STALE_APPROVAL",
            "Request is no longer pending",
          );
          const desktop = this.desktopApprovals.get(p.approvalId);
          if (desktop) {
            desktop(p as HumanDecision);
            this.desktopApprovals.delete(p.approvalId);
            this.spool({
              launchId: c.launchId,
              sessionId: entry.session.spec.sessionId,
              agentId: entry.agent.id,
              runId: entry.runId,
              lane: [],
              occurredAt: now(),
              kind: "approval.resolved",
              approvalId: p.approvalId,
              outcome:
                p.action === "approve"
                  ? "accepted"
                  : p.action === "deny"
                    ? "denied"
                    : "cancelled",
            });
          } else await entry.session.respond(p, AbortSignal.timeout(10000));
          this.db.run(
            "UPDATE pending_approvals SET state='answered',response_json=? WHERE approval_id=?",
            JSON.stringify(p),
            p.approvalId,
          );
        }
        return { delivered: true };
      case "desktop.stop": {
        const owner = this.gateway.state();
        if (!owner.owner_run_id) return { stopping: false, state: owner.state };
        this.gateway.stop(owner.owner_run_id);
        const active = this.sessions.get(owner.owner_launch_id);
        invariant(
          active && active.runId === owner.owner_run_id,
          "DESKTOP_STOP_UNCONFIRMED",
          "Original session unavailable; desktop remains blocked",
        );
        active.abort?.abort();
        const receipt = await active.session.interrupt(
          owner.owner_run_id,
          AbortSignal.timeout(30000),
        );
        return { ...receipt, state: this.gateway.state().state };
      }
      case "desktop.clear_quarantine":
        return { cleared: await this.gateway.clear() };
      default:
        throw new Error("Unsupported Host command " + c.kind);
    }
  }
  private spool(e: Row) {
    const seq = this.db.get(
      "SELECT COALESCE(MAX(producer_seq),0) n FROM event_spool WHERE launch_id=?",
      e.launchId,
    )!.n;
    const last = Number(this.db.meta("seq:" + e.launchId) ?? "0");
    const event = { ...e, producerSeq: Math.max(seq, last) + 1 };
    this.db.tx(() => {
      if (e.kind === "approval.requested") {
        const r = e.request;
        this.db.run(
          "INSERT OR IGNORE INTO pending_approvals VALUES (?,?,?,?,?,'pending',NULL,?)",
          r.approvalId,
          e.launchId,
          e.runId,
          r.nativeRequestId,
          r.argumentHash,
          now(),
        );
      }
      if (e.kind === "turn.terminal")
        this.db.run(
          "UPDATE pending_approvals SET state='cancelled' WHERE run_id=? AND state='pending'",
          e.runId,
        );
      this.db.run(
        "INSERT INTO event_spool VALUES (?,?,?,0)",
        e.launchId,
        event.producerSeq,
        JSON.stringify(event),
      );
      this.db.setMeta("seq:" + e.launchId, String(event.producerSeq));
    });
    this.flush();
  }
  private flush() {
    if (!this.epoch) return;
    const rows = this.db.all(
      "SELECT event_json FROM event_spool ORDER BY launch_id,producer_seq LIMIT 100",
    );
    const batch: Row[] = [];
    let size = 128;
    for (const row of rows) {
      const bytes = Buffer.byteLength(row.event_json) + 1;
      if (size + bytes > 1000000) break;
      batch.push(JSON.parse(row.event_json));
      size += bytes;
    }
    if (batch.length) this.send({ type: "events_batch", events: batch });
    this.send({ type: "resource_snapshot", resource: this.gateway.state() });
  }
  inventory() {
    return Host.probeInventory(this.config);
  }
  static probeInventory(config: HostConfig) {
    return ["codex-app-server", "claude-code-sdk"].map((driver) => {
      if (config.mode === "fake")
        return {
          driver,
          executableProfile:
            driver === "codex-app-server" ? "local-codex" : "local-claude",
          version: "fake-1",
          available: true,
          authenticated: null,
          models: ["fake"],
          features: ["FAKE_RUNTIME"],
          diagnostic: "Deterministic fake; no native model is invoked",
        };
      try {
        const path = executablePath(
          driver === "codex-app-server" ? config.codexPath : config.claudePath,
        );
        return {
          driver,
          executableProfile:
            driver === "codex-app-server" ? "local-codex" : "local-claude",
          version: execFileSync(path, ["--version"], {
            encoding: "utf8",
          }).trim(),
          available: true,
          authenticated: null,
          models: ["default"],
          features: [],
          diagnostic: "Native model and approval gates not run",
        };
      } catch (e) {
        return {
          driver,
          executableProfile: driver,
          version: null,
          available: false,
          authenticated: null,
          models: [],
          features: [],
          diagnostic: String(e),
        };
      }
    });
  }
  async close() {
    this.stopped = true;
    clearInterval(this.interval);
    for (const [launchId, s] of this.sessions) {
      s.abort?.abort();
      if (s.runId) this.gateway.stop(s.runId);
      const runId = s.runId;
      const receipt = await s.session
        .close("shutdown", AbortSignal.timeout(10000))
        .catch(() => null);
      if (
        receipt?.resourcesQuiescent &&
        (!runId || (await this.gateway.drain(runId, "Shutdown")))
      )
        this.db.run(
          "UPDATE launches SET state='closed',current_run_id=NULL WHERE launch_id=?",
          launchId,
        );
    }
    this.ws?.close();
    await new Promise<void>((r) =>
      this.broker ? this.broker.close(() => r()) : r(),
    );
    if (this.lockFd !== undefined) {
      closeSync(this.lockFd);
      unlinkSync(join(this.config.stateDir, "host", "host.lock"));
    }
    this.db.close();
  }
}
