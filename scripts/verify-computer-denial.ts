import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { LcuProvider } from "../packages/computer-lcu/src/index.js";
import { uuid } from "../packages/persistence/src/index.js";
const { lcu: config } = JSON.parse(
  readFileSync(join(homedir(), ".harbor/host/config.json"), "utf8"),
);
await new LcuProvider(config).probe();
const { createCuaClient } = await import(
  pathToFileURL(config.clientModule).href
);
let denied = 0;
const client = createCuaClient({
  command: config.command,
  adapter: "harbor-denial-test",
  onElicitation: async () => {
    denied++;
    return { action: "decline" };
  },
});
const binding = { sessionId: "harbor-denial-" + uuid(), turnId: uuid() };
try {
  await client.connect();
  const result = await client.call(
    "js",
    {
      code: 'var calculator = await cua.getApp("com.apple.calculator");',
      title: "验证拒绝授权阻止应用访问",
    },
    binding,
  );
  const receipt = await client.turnEnded({ ...binding, event: "Interrupt" });
  const passed =
    denied > 0 &&
    result.isError === true &&
    !result.content.some((b: any) => b.type === "image") &&
    receipt &&
    !receipt.isError;
  const report = {
    generatedAt: new Date().toISOString(),
    denied,
    accessDenied: result.isError === true,
    returnedImages: result.content.filter((b: any) => b.type === "image")
      .length,
    interruptCleanupConfirmed: !!receipt && !receipt.isError,
    passed,
  };
  writeFileSync(
    "docs/reports/computer-denial.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (!passed) process.exitCode = 1;
} finally {
  await client.close();
}
