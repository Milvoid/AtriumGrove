import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, uuid } from "../packages/persistence/src/index.js";
import { ComputerGateway } from "../packages/computer-gateway/src/index.js";
import { Barrier } from "../packages/runtime-testkit/src/index.js";
import type {
  ComputerUseProvider,
  DesktopContext,
} from "../spec/contracts/runtime.js";
function mock(cleanup = true, barrier?: Barrier): ComputerUseProvider {
  return {
    id: "mock",
    probe: async () => ({
      available: true,
      providerVersion: "test",
      runtimeFingerprint: "test",
      instructionsSha256: "a",
      toolSchemaSha256: "b",
      interactiveApprovals: true,
      cleanup: "confirmed",
      diagnostics: [],
    }),
    open: async () => ({
      instructions: "test",
      publicTools: [],
      invoke: async () => {
        await barrier?.promise;
        return { content: [{ type: "text", text: "done" }] };
      },
      endTurn: async () => ({ quiescent: cleanup, receipt: { test: true } }),
      close: async () => {},
    }),
  };
}
const ctx = (): Omit<DesktopContext, "leaseEpoch"> => ({
  workspaceId: uuid(),
  agentId: uuid(),
  launchId: uuid(),
  runId: uuid(),
  hostSessionId: uuid(),
  hostTurnId: uuid(),
  resourceId: "console",
});
test("F11 F12 F13: terminal waits for inflight call, stale epoch rejected", async () => {
  const db = new Store(":memory:", "host"),
    barrier = new Barrier(),
    gateway = new ComputerGateway(db, "console", mock(true, barrier));
  try {
    await gateway.qualify(true);
    const context = await gateway.acquire(ctx(), async () => {
      throw new Error("not used");
    });
    const call = gateway.call("js", { code: "test" }, context);
    let drained = false;
    const draining = gateway.drain(context.runId).then((v) => {
      drained = v;
    });
    assert.equal(gateway.state().state, "draining");
    assert.equal(drained, false);
    await assert.rejects(() =>
      gateway.acquire(
        ctx(),
        async () => {
          throw new Error();
        },
        { waitMs: 0 },
      ),
    );
    await assert.rejects(() =>
      gateway.call("js", {}, { ...context, leaseEpoch: 0 }),
    );
    barrier.release();
    await call;
    await draining;
    assert.equal(drained, true);
    assert.equal(gateway.state().state, "free");
  } finally {
    db.close();
  }
});
test("F18 A39: unconfirmed cleanup quarantines, no prompt-only approval boundary", async () => {
  const db = new Store(":memory:", "host"),
    gateway = new ComputerGateway(db, "console", mock(false));
  try {
    await assert.rejects(() => gateway.qualify(false));
    await gateway.qualify(true);
    const c = await gateway.acquire(ctx(), async () => {
      throw new Error();
    });
    assert.equal(await gateway.drain(c.runId), false);
    assert.equal(gateway.state().state, "quarantined");
    await assert.rejects(() =>
      gateway.acquire(
        ctx(),
        async () => {
          throw new Error();
        },
        { waitMs: 0 },
      ),
    );
  } finally {
    db.close();
  }
});

test("Concurrent calls by one owner share opening; a different owner's stop cannot abort it", async () => {
  const db = new Store(":memory:", "host"),
    provider = mock(),
    opening = new Barrier();
  let opens = 0,
    cleanup = 0;
  const baseOpen = provider.open;
  provider.open = async (...args) => {
    opens++;
    await opening.promise;
    const connection = await baseOpen(...args);
    const end = connection.endTurn;
    connection.endTurn = async (...a) => {
      cleanup++;
      return end(...a);
    };
    return connection;
  };
  const gateway = new ComputerGateway(db, "console", provider),
    owner = ctx();
  try {
    await gateway.qualify(true);
    const first = gateway.acquire(owner, async () => {
      throw new Error();
    });
    const second = gateway.acquire(owner, async () => {
      throw new Error();
    });
    gateway.stop(uuid());
    assert.equal(gateway.state().state, "held");
    opening.release();
    assert.deepEqual(await first, await second);
    assert.equal(opens, 1);
    assert.deepEqual(
      await Promise.all([
        gateway.drain(owner.runId),
        gateway.drain(owner.runId),
      ]),
      [true, true],
    );
    assert.equal(cleanup, 1);
  } finally {
    db.close();
  }
});

test("Waiting desktop owner can cancel without acquiring the lease", async () => {
  const db = new Store(":memory:", "host"),
    gateway = new ComputerGateway(db, "console", mock());
  try {
    await gateway.qualify(true);
    const owner = await gateway.acquire(ctx(), async () => {
      throw new Error();
    });
    const cancel = new AbortController();
    const waiting = gateway.acquire(
      ctx(),
      async () => {
        throw new Error();
      },
      { signal: cancel.signal },
    );
    cancel.abort();
    await assert.rejects(waiting, /abort/i);
    assert.equal(gateway.state().owner_run_id, owner.runId);
    await gateway.drain(owner.runId);
  } finally {
    db.close();
  }
});
