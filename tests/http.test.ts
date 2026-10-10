import { mkdtempSync } from "../scripts/test-resources.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../apps/control/src/server.js";
import { uuid } from "../packages/persistence/src/index.js";
test("A01 A02: login nonce, CSRF, revocation and loopback origin boundary", async () => {
  const { app, service } = await createServer(
    mkdtempSync(join(tmpdir(), "harbor-http-")),
    { schedule: false, serveWeb: false },
  );
  try {
    const expired = service.auth.nonce();
    service.store.run(
      "UPDATE login_nonces SET expires_at='2000-01-01T00:00:00.000Z'",
    );
    assert.throws(() => service.auth.exchange(expired), /expired/);
    const token = service.auth.nonce();
    const exchange = await app.inject({
      method: "POST",
      url: "/v1/auth/exchange",
      headers: { host: "127.0.0.1:4310" },
      payload: { oneTimeToken: token },
    });
    assert.equal(exchange.statusCode, 200, exchange.body);
    const cookies = exchange.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; "),
      csrf = exchange.json().csrfToken;
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/exchange",
      headers: { host: "127.0.0.1:4310" },
      payload: { oneTimeToken: token },
    });
    assert.equal(replay.statusCode, 401);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: {
        host: "127.0.0.1:4310",
        cookie: cookies,
        "Idempotency-Key": uuid(),
      },
      payload: { name: "test" },
    });
    assert.equal(missing.statusCode, 403);
    const headers = {
      host: "127.0.0.1:4310",
      cookie: cookies,
      "X-CSRF-Token": csrf,
      "Idempotency-Key": uuid(),
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers,
      payload: { name: "test" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers,
      payload: { name: "test" },
    });
    assert.equal(duplicate.json().id, created.json().id);
    const evil = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: { ...headers, origin: "https://evil.example" },
    });
    assert.equal(evil.statusCode, 403);
    const session1 = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers,
    });
    const session2 = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers,
    });
    assert.equal(session1.json().csrfToken, session2.json().csrfToken);
    await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers,
      payload: {},
    });
    const revoked = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers,
    });
    assert.equal(revoked.statusCode, 401);
  } finally {
    await app.close();
  }
});
