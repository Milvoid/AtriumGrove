import {
  verifyDirectory,
  verifyProject,
} from "../../../packages/worktrees/src/index.js";
import { readAccess, configureAccess } from "./access.js";
import {
  backupState,
  restoreState,
} from "../../../packages/persistence/src/backup.js";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { backup } from "node:sqlite";
import { parse } from "yaml";
import {
  Store,
  sha,
  uuid,
  now,
} from "../../../packages/persistence/src/index.js";
import { Service } from "./service.js";
import { createServer } from "./server.js";
import { Host, type HostConfig } from "../../host/src/host.js";
import { invariant } from "../../../packages/domain/src/index.js";
const args = process.argv.slice(2),
  command = args[0] ?? "help";
const option = (name: string, fallback?: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const state = resolve(
  option("--state", process.env.HARBOR_HOME ?? join(homedir(), ".harbor"))!,
);
const port = Number(option("--port", "4310"));
function prepare() {
  for (const dir of ["control", "host", "artifacts", "worktrees", "logs"]) {
    mkdirSync(join(state, dir), { recursive: true, mode: 0o700 });
    chmodSync(join(state, dir), 0o700);
  }
}
function service() {
  prepare();
  return new Service(new Store(join(state, "control", "control.db")), state);
}
function binary(name: string) {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim();
  } catch {
    return name;
  }
}
function enrollment(s: Service, mode: "native" | "fake") {
  const configPath = join(state, "host", "config.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as HostConfig;
    config.mode = mode;
    config.controllerUrl = `http://127.0.0.1:${port}`;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
    });
    return config;
  }
  const hostId = uuid(),
    credential = randomBytes(32).toString("base64url");
  s.store.run(
    "INSERT INTO hosts(id,name,credential_hash,platform,architecture,state) VALUES (?,?,?,?,?,'offline')",
    hostId,
    hostname(),
    sha(credential),
    process.platform,
    process.arch,
  );
  const config: HostConfig = {
    hostId,
    credential,
    controllerUrl: `http://127.0.0.1:${port}`,
    stateDir: state,
    mode,
    codexPath: binary("codex"),
    claudePath: binary("claude"),
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  return config;
}
function demo(s: Service, hostId: string) {
  const root = join(state, "demo-project");
  if (!existsSync(join(root, ".git"))) {
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "-b", "main", root]);
    writeFileSync(
      join(root, "README.md"),
      "# Atrium Grove verification sandbox\n\nOnly generated, nonsensitive test content belongs here.\n",
    );
    execFileSync("git", ["-C", root, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Atrium Grove Fixture",
      "-c",
      "user.email=fixture@localhost",
      "commit",
      "-m",
      "Initialize verification fixture",
    ]);
  }
  return s.store.tx(() => {
    const w = s.createWorkspace("Atrium Grove Lab"),
      project = uuid();
    s.store.run(
      "INSERT INTO projects(id,workspace_id,host_id,name,root_path,base_ref,version) VALUES (?,?,?,?,?,?,1)",
      project,
      w.id,
      hostId,
      "Verification sandbox",
      root,
      "HEAD",
    );
    const channel = s.createChannel(
      w.id,
      "general",
      "Five independent participants • one shared goal",
    );
    const names = [
      "codex-researcher",
      "codex-implementer",
      "codex-desktop",
      "claude-architect",
      "claude-reviewer",
    ];
    const ids: string[] = [];
    for (const [index, name] of names.entries()) {
      const driver = index < 3 ? "codex-app-server" : "claude-code-sdk";
      const a = s.createAgent(w.id, {
        hostId,
        projectId: project,
        name,
        role: [
          "Research assumptions and boundaries",
          "Claim implementation tasks and provide tests",
          "Verify the product using permitted tools",
          "Design components and acceptance criteria",
          "Review a fixed commit independently",
        ][index],
        runtime: {
          driver,
          executableProfile: index < 3 ? "local-codex" : "local-claude",
          model: "default",
          permissionProfile: "workspace",
          settingsProfile: "project-reviewed",
        },
        capabilities: [
          "collab.read",
          "collab.post",
          "task.read",
          "task.create",
          "task.claim",
          "task.transition",
          "task.review",
          "artifact.read",
          "artifact.register",
          "memory.propose",
        ],
      });
      ids.push(a.id);
      s.store.run(
        "INSERT INTO channel_members VALUES (?,?,?)",
        channel.id,
        a.id,
        now(),
      );
    }
    return {
      workspaceId: w.id,
      channelId: channel.id,
      agentIds: ids,
      projectRoot: root,
    };
  });
}
async function run() {
  switch (command) {
    case "init": {
      const s = service();
      const c = enrollment(s, args.includes("--fake") ? "fake" : "native");
      console.log(
        JSON.stringify(
          {
            stateDir: state,
            hostId: c.hostId,
            mode: c.mode,
            loginToken: s.auth.nonce(),
          },
          null,
          2,
        ),
      );
      s.store.close();
      break;
    }
    case "login-token": {
      const s = service();
      console.log(s.auth.nonce());
      s.store.close();
      break;
    }
    case "access": {
      invariant(
        args.includes("--password-stdin"),
        "USAGE",
        "Use access --public-url URL --password-stdin",
      );
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      await configureAccess(
        state,
        option("--public-url")!,
        Buffer.concat(chunks).toString("utf8").trimEnd(),
      );
      const s = service();
      s.store.run("UPDATE auth_sessions SET revoked_at=?", now());
      s.store.close();
      console.log(
        "Access configuration saved. Existing sessions revoked. Restart the control server.",
      );
      break;
    }
    case "serve": {
      prepare();
      const { app } = await createServer(state);
      const access = readAccess(state);
      const listenPort = Number(
        option(
          "--port",
          access ? new URL(access.publicUrl).port || "80" : "4310",
        ),
      );
      await app.listen({
        host: access ? "0.0.0.0" : "127.0.0.1",
        port: listenPort,
      });
      console.log(
        `Atrium Grove: ${access?.publicUrl ?? `http://127.0.0.1:${listenPort}`}`,
      );
      for (const sig of ["SIGINT", "SIGTERM"])
        process.once(sig, () => {
          void app.close().then(() => process.exit(0));
        });
      break;
    }
    case "host": {
      invariant(args[1] === "start", "USAGE", "Use pnpm atrium-grove host start");
      const config = JSON.parse(
        readFileSync(join(state, "host", "config.json"), "utf8"),
      );
      const host = new Host(config);
      await host.start();
      console.log(`Host ${config.hostId} connected in ${config.mode} mode`);
      for (const sig of ["SIGINT", "SIGTERM"])
        process.once(sig, () => {
          void host.close().then(() => process.exit(0));
        });
      break;
    }
    case "demo": {
      const s = service();
      const c = enrollment(s, args.includes("--native") ? "native" : "fake");
      const result = demo(s, c.hostId);
      console.log(
        JSON.stringify(
          {
            ...result,
            mode: c.mode,
            loginToken: s.auth.nonce(),
            notice:
              c.mode === "fake"
                ? "No model calls; native gates NOT_RUN"
                : "Native CLI models may consume your account usage",
          },
          null,
          2,
        ),
      );
      s.store.close();
      break;
    }
    case "doctor": {
      const c = JSON.parse(
        readFileSync(join(state, "host", "config.json"), "utf8"),
      ) as HostConfig;
      console.log(
        JSON.stringify(
          {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
            inventory: Host.probeInventory(c),
            computer: {
              configured: !!c.lcu,
              qualified: false,
              reason: "Q2–Q4 and approval-host exclusion require verification",
            },
            gates: {
              Q0: "NOT_RUN",
              Q1: "NOT_RUN",
              Q2: "NOT_RUN",
              Q3: "NOT_RUN",
              Q4: "NOT_RUN",
            },
          },
          null,
          2,
        ),
      );
      break;
    }
    case "team": {
      invariant(
        args[1] === "import" && args[2],
        "USAGE",
        "pnpm atrium-grove team import <yaml> --vars <json> [--dry-run]",
      );
      const vars = option("--vars")
        ? JSON.parse(readFileSync(option("--vars")!, "utf8"))
        : {};
      const substitute = (value: any): any =>
        typeof value === "string"
          ? value.replace(/\$\{([A-Z_]+)\}/g, (_match, key) => {
              invariant(
                typeof vars[key] === "string" && !vars[key].includes("REPLACE"),
                "IMPORT_VARIABLE",
                "Missing explicit variable " + key,
              );
              return vars[key];
            })
          : Array.isArray(value)
            ? value.map(substitute)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value).map(([key, v]) => [key, substitute(v)]),
                )
              : value;
      const team = substitute(parse(readFileSync(args[2], "utf8")));
      invariant(
        !JSON.stringify(team).includes("REPLACE"),
        "IMPORT_VARIABLE",
        "Example placeholders are not valid",
      );
      invariant(
        team.schemaVersion === 1 &&
          Array.isArray(team.agents) &&
          new Set(team.agents.map((a: any) => a.name)).size ===
            team.agents.length,
        "INVALID_TEAM",
        "Invalid team schema or duplicate names",
      );
      invariant(
        existsSync(team.project.rootPath),
        "INVALID_PROJECT",
        "Project directory does not exist",
      );
      invariant(
        ["directory", "git-worktree"].includes(
          team.project.workspaceMode ?? "directory",
        ),
        "INVALID_WORKSPACE_MODE",
        "Unknown workspace mode",
      );
      const checkedProject =
        team.project.workspaceMode === "git-worktree"
          ? await verifyProject(
              team.project.rootPath,
              team.project.baseRef ?? "HEAD",
            )
          : await verifyDirectory(team.project.rootPath);
      team.project.rootPath = checkedProject.rootPath;
      for (const ch of team.channels)
        for (const name of ch.agents)
          invariant(
            team.agents.some((a: any) => a.name === name),
            "INVALID_MEMBER",
            "Unknown agent " + name,
          );
      if (args.includes("--dry-run")) {
        console.log(
          JSON.stringify(
            {
              valid: true,
              agents: team.agents.length,
              project: team.project.rootPath,
              nativeQualification: "NOT_RUN",
            },
            null,
            2,
          ),
        );
        break;
      }
      const s = service(),
        config = enrollment(s, "native");
      const result = s.store.tx(() => {
        const ws = s.createWorkspace(team.workspace.name),
          project = uuid();
        s.store.run(
          "UPDATE workspaces SET policy_json=? WHERE id=?",
          JSON.stringify(team.policy),
          ws.id,
        );
        s.store.run(
          "INSERT INTO projects(id,workspace_id,host_id,name,root_path,base_ref,workspace_mode,version) VALUES (?,?,?,?,?,?,?,1)",
          project,
          ws.id,
          config.hostId,
          team.project.name,
          team.project.rootPath,
          team.project.baseRef ?? "HEAD",
          team.project.workspaceMode ?? "directory",
        );
        const agents = new Map<string, string>();
        for (const a of team.agents)
          agents.set(
            a.name,
            s.createAgent(ws.id, {
              ...a,
              hostId: config.hostId,
              projectId: project,
            }).id,
          );
        for (const ch of team.channels) {
          const channel = s.createChannel(ws.id, ch.name, ch.topic);
          for (const name of ch.agents)
            s.store.run(
              "INSERT INTO channel_members VALUES (?,?,?)",
              channel.id,
              agents.get(name)!,
              now(),
            );
        }
        return ws;
      });
      console.log(JSON.stringify(result, null, 2));
      s.store.close();
      break;
    }
    case "backup": {
      invariant(args[1], "USAGE", "pnpm atrium-grove backup <directory>");
      console.log(
        JSON.stringify(await backupState(state, resolve(args[1])), null, 2),
      );
      break;
    }
    case "restore": {
      invariant(
        args[1],
        "USAGE",
        "pnpm atrium-grove restore <backup-directory> --state <new-directory>",
      );
      console.log(
        JSON.stringify(restoreState(resolve(args[1]), state), null, 2),
      );
      break;
    }
    case "export-run": {
      invariant(args[1], "USAGE", "pnpm atrium-grove export-run <id>");
      const s = service(),
        run = s.get("Run", args[1]);
      const events = s.store.all(
        "SELECT kind,lane_json,occurred_at FROM runtime_events WHERE run_id=? ORDER BY producer_seq",
        run.id,
      );
      console.log(
        JSON.stringify(
          { run, events, note: "Raw native payloads and credentials excluded" },
          null,
          2,
        ),
      );
      s.store.close();
      break;
    }
    default:
      console.log(
        "Atrium Grove\n  init [--fake]\n  serve [--port 4310]\n  host start\n  login-token\n  demo [--native]\n  doctor\n  team import <yaml> --vars <json> [--dry-run]\n  backup <directory>\n  restore <backup-directory> --state <new-directory>\n  export-run <id>\nAll commands accept --state <directory>.",
      );
  }
}
run().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
