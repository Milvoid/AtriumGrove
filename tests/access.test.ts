import { mkdtempSync } from "../scripts/test-resources.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureAccess,
  readAccess,
  verifyPassword,
  checkOrigin,
} from "../apps/control/src/access.js";
import { createServer } from "../apps/control/src/server.js";

test("LAN password login preserves host/origin, cookie, CSRF and brute-force boundaries", async () => {
  const state = mkdtempSync(join(tmpdir(), "harbor-lan-test-"));
  const password = "disposable-test-password-42";
  await configureAccess(state, "http://harbor-test.local:4317", password);
  const c = readAccess(state)!;
  assert.equal(await verifyPassword(c, password), true);
  assert.equal(await verifyPassword(c, "wrong"), false);
  assert.equal(
    readFileSync(join(state, "access.json"), "utf8").includes(password),
    false,
  );
  assert.equal(statSync(join(state, "access.json")).mode & 0o777, 0o600);
  assert.equal(
    checkOrigin("harbor-test.local:4317", "http://harbor-test.local:4317", c),
    true,
  );
  assert.equal(
    checkOrigin("harbor-test.local:4317", "http://evil.local:4317", c),
    false,
  );
  assert.equal(checkOrigin("evil.local:4317", undefined, c), false);
  assert.equal(checkOrigin("harbor-test.local:4318", undefined, c), false);
  assert.equal(checkOrigin("[::1]:4317", "http://[::1]:4317", null), true);
  const { app } = await createServer(state, {
    schedule: false,
    serveWeb: false,
  });
  const headers = {
    host: "harbor-test.local:4317",
    origin: "http://harbor-test.local:4317",
  };
  try {
    assert.equal(
      (
        await app.inject({ method: "GET", url: "/v1/auth/config", headers })
      ).json().passwordEnabled,
      true,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/password",
          headers: { ...headers, origin: "http://evil.local:4317" },
          payload: { password },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/password",
          headers,
          payload: { password: "wrong" },
        })
      ).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/password",
      headers,
      payload: { password },
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.ok(login.cookies.find((c) => c.name === "harbor_session")?.httpOnly);
    assert.equal(
      login.cookies.find((c) => c.name === "harbor_session")?.sameSite,
      "Strict",
    );
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/v1/auth/session",
          headers: { ...headers, cookie },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/workspaces",
          headers: { ...headers, cookie },
          payload: { name: "blocked" },
        })
      ).statusCode,
      403,
    );
    for (let i = 0; i < 10; i++)
      await app.inject({
        method: "POST",
        url: "/v1/auth/password",
        headers,
        payload: { password: "wrong" },
      });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/password",
          headers,
          payload: { password },
        })
      ).statusCode,
      429,
    );
  } finally {
    await app.close();
  }
});

test("Tunnel HTTPS and explicit LAN origins coexist; cookies follow the requested host, not forwarded headers", async () => {
  const state = mkdtempSync(join(tmpdir(), "harbor-tunnel-test-"));
  const password = "temporary-tunnel-test-password";
  await configureAccess(state, "https://agents.example.com", password);
  const { writeFileSync } = await import("node:fs");
  const access = readAccess(state)!;
  access.allowedOrigins = ["http://harbor-test.local:4317"];
  writeFileSync(join(state, "access.json"), JSON.stringify(access));
  const { app } = await createServer(state, {
    schedule: false,
    serveWeb: false,
  });
  try {
    for (const [host, origin, secure] of [
      ["agents.example.com", "https://agents.example.com", true],
      ["harbor-test.local:4317", "http://harbor-test.local:4317", false],
      ["127.0.0.1:4317", "http://127.0.0.1:4317", false],
    ] as const) {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/password",
        headers: { host, origin },
        payload: { password },
      });
      assert.equal(login.statusCode, 200, login.body);
      assert.equal(
        !!login.cookies.find((c) => c.name === "harbor_session")?.secure,
        secure,
      );
    }
    for (const [host, origin] of [
      ["evil.example.com", "https://evil.example.com"],
      ["agents.example.com", "http://agents.example.com"],
      ["harbor-test.local:4317", "https://agents.example.com"],
    ]) {
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: "/v1/auth/config",
            headers: {
              host,
              origin,
              "x-forwarded-host": "agents.example.com",
              "x-forwarded-proto": "https",
            },
          })
        ).statusCode,
        403,
      );
    }
  } finally {
    await app.close();
  }
});
