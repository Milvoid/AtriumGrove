import { mkdtempSync } from "../scripts/test-resources.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../apps/control/src/server.js";
test("Idle SSE connects immediately and receives later changes without reconnecting", async () => {
  const { app, service } = await createServer(
    mkdtempSync(join(tmpdir(), "harbor-stream-")),
    { schedule: false, serveWeb: false },
  );
  const abort = new AbortController();
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const ws = service.createWorkspace("Stream test");
    const auth = service.auth.exchange(service.auth.nonce());
    const after = service.snapshot(ws.id).snapshotSeq;
    const timeout = setTimeout(() => abort.abort(), 4000);
    const response = await fetch(
      `${url}/v1/workspaces/${ws.id}/events?after=${after}`,
      {
        headers: { cookie: `harbor_session=${auth.session}` },
        signal: abort.signal,
      },
    );
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /: connected/,
    );
    service.createChannel(ws.id, "A new conversation");
    let text = "";
    while (!text.includes("channel.updated"))
      text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /A new conversation/);
    clearTimeout(timeout);
    await reader.cancel();
  } finally {
    abort.abort();
    await app.close();
  }
});

test("Controller shutdown closes a live event stream without waiting for the browser", async () => {
  const { app, service } = await createServer(
    mkdtempSync(join(tmpdir(), "harbor-close-stream-")),
    { schedule: false, serveWeb: false },
  );
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const ws = service.createWorkspace("test"),
    auth = service.auth.exchange(service.auth.nonce());
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await fetch(
      `${url}/v1/workspaces/${ws.id}/events?after=${service.snapshot(ws.id).snapshotSeq}`,
      {
        headers: { cookie: `harbor_session=${auth.session}` },
        signal: abort.signal,
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("shutdown hung on SSE")),
          2000,
        );
      }),
    ]);
    assert.equal((await reader.read()).done, true);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await app.close();
  }
});
