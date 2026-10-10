import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Archive only IDs recorded by this test run; never starts a model turn. */
export async function archiveTestThreads(executable: string, ids: string[]) {
  if (!ids.length) return;
  const child = spawn(executable, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let next = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    message.error
      ? call.reject(new Error(message.error.message))
      : call.resolve(message.result);
  });
  const fail = (error: Error) => {
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Archive process exited")));
  const timer = setTimeout(() => {
    fail(new Error("Archive timed out"));
    child.kill();
  }, 20000);
  const rpc = (method: string, params: unknown) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  try {
    await rpc("initialize", {
      clientInfo: { name: "harbor-test-cleanup", version: "0.1.0" },
    });
    child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    );
    for (const threadId of new Set(ids))
      await rpc("thread/archive", { threadId });
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
