/** Install the existing, pinned LCU bridge. No downloads, persistent app grants, or agent sessions. */
import { readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  LcuProvider,
  type LcuConfig,
} from "../packages/computer-lcu/src/index.js";
import { canonical, sha, uuid } from "../packages/persistence/src/index.js";

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
const provider = new LcuProvider(config);
const probe = await provider.probe();
if (!probe.available || probe.diagnostics.length)
  throw new Error(probe.diagnostics.join("\n") || "Computer Use unavailable");
const state = process.env.HARBOR_HOME ?? join(homedir(), ".harbor");
const configPath = join(state, "host/config.json");
if (!existsSync(configPath))
  throw new Error("Initialize the Atrium Grove Host first");
const hostConfig = JSON.parse(readFileSync(configPath, "utf8"));
if (!process.argv.includes("--verify")) {
  console.log(
    "组件可连接。实际验收并保存配置：pnpm exec tsx scripts/setup-computer.ts --verify\n验收将读取计算器界面，计算 2+2，截图，然后清空计算器并确认原组件释放。首次应用授权会单独询问，不会自动批准。",
  );
  process.exit(0);
}
const { createCuaClient } = await import(
  pathToFileURL(config.clientModule).href
);
const input = createInterface({ input: process.stdin, output: process.stdout });
const binding = { sessionId: "harbor-qualification-" + uuid(), turnId: uuid() };
let appApprovalDenied = false;
const client = createCuaClient({
  command: config.command,
  adapter: "harbor-qualification",
  onElicitation: async (p: any) => {
    const app = p?._meta?.tool_params?.app;
    if (app !== "com.apple.calculator") return { action: "decline" };
    console.log(
      JSON.stringify({
        approvalRequired: true,
        application: app,
        message: p.message,
        scope: "once",
      }),
    );
    const response = await input.question(
      "允许本次验收操作计算器？输入 allow-once 或 deny：",
    );
    if (response.trim() !== "allow-once") {
      appApprovalDenied = true;
      return { action: "decline" };
    }
    return { action: "accept", content: {} };
  },
});
let connected = false,
  cleaned = false;
const check = (result: any, phase: string) => {
  if (result.isError)
    throw new Error(
      `${phase}: ${String(result.content?.find((b: any) => b.type === "text")?.text ?? "Native tool failed").slice(0, 1000)}`,
    );
  return result;
};
try {
  await client.connect();
  connected = true;
  provider.assertExclusion();
  check(
    await client.call(
      "js",
      {
        code: 'var calculator = await cua.getApp("com.apple.calculator");',
        title: "验证计算器观察",
      },
      binding,
    ),
    "Observe",
  );
  if (appApprovalDenied)
    throw new Error("应用授权未获批准；不会启用 Computer Use");
  const result = check(
    await client.call(
      "js",
      {
        code: 'await calculator.pressKey("Escape"); await calculator.pressKey("2"); await calculator.pressKey("plus"); await calculator.pressKey("2"); await calculator.pressKey("Return"); await calculator.getAXState();',
        title: "验证计算器输入",
      },
      binding,
    ),
    "Input",
  );
  const text = result.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  if (!/4/.test(text)) throw new Error("Calculator result not observed");
  const screenshot = check(
    await client.call(
      "js",
      { code: "await calculator.getScreenshot();", title: "验证截图返回" },
      binding,
    ),
    "Screenshot",
  );
  const image = screenshot.content.find(
    (b: any) => b.type === "image" && b.data,
  );
  if (!image) throw new Error("Provider returned no image");
  check(
    await client.call(
      "js",
      {
        code: 'await calculator.pressKey("Escape"); await calculator.getAXState();',
        title: "清理验收输入",
      },
      binding,
    ),
    "Clear",
  );
  check(await client.call("js_reset", {}, binding), "Reset");
  const receipt = await client.turnEnded({ ...binding, event: "Stop" });
  if (!receipt || receipt.isError)
    throw new Error("Native cleanup unconfirmed");
  cleaned = true;
  config.qualification = {
    runtimeFingerprint: probe.runtimeFingerprint,
    instructionsSha256: probe.instructionsSha256,
    toolSchemaSha256: probe.toolSchemaSha256,
    cleanupConfirmed: true,
    humanControlHostExcluded: true,
  };
  if (
    sha(client.instructions) !== probe.instructionsSha256 ||
    sha(canonical(client.publicTools())) !== probe.toolSchemaSha256
  )
    throw new Error("Runtime changed during qualification");
  hostConfig.lcu = config;
  writeFileSync(configPath, JSON.stringify(hostConfig, null, 2) + "\n", {
    mode: 0o600,
  });
  writeFileSync(
    "docs/reports/computer-qualification.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        providerVersion: config.providerVersion,
        ...config.qualification,
        application: "com.apple.calculator",
        screenshotSha256: sha(Buffer.from(image.data, "base64")),
        screenshotMimeType: image.mimeType,
        cleanupReceipt: receipt,
        tests: {
          observe: "PASS",
          input: "PASS",
          screenshot: "PASS",
          reset: "PASS",
          cleanup: "PASS",
          crossHarness: "NOT_RUN",
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "原生观察、输入、截图及释放已验证；Host 配置已保存。重启 Host 后生效，所有成员的 Computer Use 开关仍保持原值。",
  );
} finally {
  if (connected && !cleaned)
    await client.turnEnded({ ...binding, event: "Interrupt" }).catch(() => {});
  await client.close();
  input.close();
}
