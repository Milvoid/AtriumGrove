import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  LcuProvider,
  type LcuConfig,
} from "../packages/computer-lcu/src/index.js";
import { sha } from "../packages/persistence/src/index.js";
const root = realpathSync(resolve(".tools/lcu-runtime/current"));
const resources = "/Applications/ChatGPT.app/Contents/Resources";
const config: LcuConfig = {
  clientModule: join(root, "adapters/client.mjs"),
  command: [join(root, "bin/lcu")],
  clientSha256: sha(readFileSync(join(root, "adapters/client.mjs"))),
  providerVersion: execFileSync(join(root, "bin/lcu"), ["--version"], {
    encoding: "utf8",
  }).trim(),
  approvalHostBundleId: "com.openai.codex",
  runtimeFiles: [
    join(root, "bin/lcu"),
    join(root, "lcu/runtime.mjs"),
    join(resources, "cua_node/bin/node"),
    join(resources, "cua_node/bin/node_repl"),
    join(resources, "cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs"),
    join(resources, "codex-cli/bin/codex-code-mode-host"),
  ],
};
try {
  const provider = new LcuProvider(config),
    result = await provider.probe();
  const report = {
    generatedAt: new Date().toISOString(),
    status: "PROBED_NOT_QUALIFIED",
    ...result,
    toolNames: provider.publicTools.map((t) => t.name),
    notes: [
      "No desktop actions or permission grants were performed.",
      "Real cleanup, cross-harness screenshot exchange and exclusion gates remain NOT_RUN.",
    ],
  };
  writeFileSync(
    "docs/reports/lcu-probe.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} catch (error) {
  writeFileSync(
    "docs/reports/lcu-probe.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        status: "BLOCKED",
        error: String(error),
      },
      null,
      2,
    ) + "\n",
  );
  console.error(String(error));
  process.exitCode = 1;
}
