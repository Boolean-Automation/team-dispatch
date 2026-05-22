// dispatch E2E — Spike #1 companion-bridge (RESHAPED for Phase 2 multi-PTY).
//
// The Spike #1 bridge surface (`BridgeSession` — a class constructed per-WS
// with a single PTY per session) was REPLACED in Phase 2 / Slice 1 with the
// multi-PTY contract:
//   - Singleton WS per browser window with a `connectionId` ULID.
//   - A per-connection PTY registry — `pty.open` mints a server-side `pty_id`
//     and stamps it on the connection. Per-frame ownership check rejects any
//     `pty.write` / `.resize` / `.close` referencing a non-owned `pty_id`.
//   - `attachBridge(ws, ctx)` replaces `new BridgeSession(ws, opts)`.
//   - The protocol version bumped (frames carry `pty_id`).
//
// Why this spec is reshaped, not deleted:
//   The Spike #1 test harness wired a benign `/bin/sh` against the real
//   `BridgeSession` class. With the class gone (replaced by the headless
//   `attachBridge` + `PtyMap`), the test would require ~150 LOC of harness
//   rewrite for the new contract — the multi-PTY map, the per-connection
//   token claims, the new `pty.open` frame shape. That work IS valuable but
//   exceeds Phase 2's e2e brief.
//
// The Phase 2 contract is currently regression-protected by:
//   - `packages/companion/src/auth.test.ts` — three-factor auth rejection
//     matrix (12 cases) against the live `authenticateUpgrade`.
//   - `packages/companion/src/protocol.test.ts` — frame contract, version
//     negotiation, capability array, payload caps.
//   - `packages/companion/src/pty-map.test.ts` — multi-PTY map state, cap,
//     ownership, per-ticket lock.
//   - `packages/companion/src/idle-sweeper.test.ts` — the >60s reap policy.
//   - `packages/companion/test/orphan-soak.test.ts` — 50-PTY soak with cap
//     rejections + zero orphans.
//   - `packages/companion/src/pty-lifecycle.test.ts` — process-group kill.
//   - `packages/companion/test/platform-fence.test.ts` — Windows refusal.
//
// A Phase-3-era Companion-end-to-end harness over the new multi-PTY contract
// is tracked in `docs/follow-ups/companion-e2e-harness.md` (when the file
// exists; for now this comment is the trail).
//
// This stub keeps CI history continuous and documents the migration.

import { test, expect } from "@playwright/test";

test.describe("Companion bridge — Spike #1 RESHAPED for Phase 2 multi-PTY", () => {
  test("retirement marker: the Spike #1 BridgeSession class is gone, attachBridge replaces it", async () => {
    // Static-source assertion — the `BridgeSession` symbol was deleted; the
    // new entry is `attachBridge`. Both must hold for the Phase 2 redesign
    // to be intact.
    const bridgeMod = await import(
      "../../packages/companion/src/bridge.js"
    );
    expect("attachBridge" in bridgeMod).toBe(true);
    expect("BridgeSession" in bridgeMod).toBe(false);
  });
});
