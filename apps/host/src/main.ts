import { Host, type HostConfig } from "./host.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const state = process.env.HARBOR_HOME ?? join(homedir(), ".harbor");
const host = new Host(
  JSON.parse(
    readFileSync(join(state, "host", "config.json"), "utf8"),
  ) as HostConfig,
);
await host.start();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void host.close().then(() => process.exit(0));
  });
