import { mkdtempSync } from "./test-resources.js";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "../apps/control/src/server.js";
import { Host } from "../apps/host/src/host.js";
const state = process.argv[2] ?? mkdtempSync(join(tmpdir(), "harbor-preview-"));
if (!process.argv[2])
  execFileSync(
    process.execPath,
    ["--import", "tsx", "apps/control/src/cli.ts", "demo", "--state", state],
    { stdio: "pipe" },
  );
const { app, service, scheduler } = await createServer(state);
const url = await app.listen({
  host: "127.0.0.1",
  port: Number(process.env.HARBOR_PREVIEW_PORT ?? 0),
});
const config = JSON.parse(
  readFileSync(join(state, "host/config.json"), "utf8"),
);
config.controllerUrl = url;
const host = new Host(config);
await host.start();
console.log(
  JSON.stringify({
    url,
    state,
    loginToken: service.auth.nonce(),
    mode: config.mode,
  }),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    scheduler.stop();
    void host
      .close()
      .then(() => app.close())
      .then(() => process.exit(0));
  });
