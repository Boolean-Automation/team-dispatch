// dispatch E2E — Spike #1 companion-helpers (RESHAPED for Phase 2).
//
// The Spike #1 helpers (`startBridgeServer`, `mintToken`, etc.) drove the
// `BridgeSession` class against a benign `/bin/sh` PTY. Phase 2 / Slice 1
// replaced `BridgeSession` with `attachBridge` + `PtyMap` — see
// `companion-bridge.spec.ts` for the migration trail.
//
// The Phase 2 e2e suite drives the browser-side terminal panel through the
// HELPERS in `terminal-helpers.ts` instead. The Companion-side multi-PTY
// contract is regression-protected by `packages/companion/{src,test}/*.test.ts`.
//
// This file is kept (empty) so any stale README/comment links to
// `companion-helpers.ts` still resolve to a real path on disk while
// documenting the move. A Phase-3 Companion-e2e harness rebuilt on the new
// `attachBridge` contract would land here.

export {};
