// terminal-transport.test.ts — the degradation-seam proof (A14b).
//
// The seam is real only if BOTH transports satisfy the SAME `TerminalTransport`
// type and `PanelTerminal` / `useCompanion` accept either with NO change.
// This test substitutes the stub fallback transport and asserts:
//   1. `FallbackTransportStub` and `CompanionWsTransport` are both assignable
//      to `TerminalTransport` (compile-level — the type accepts the stub).
//   2. The stub `connect()` resolves to a defined `degraded` state — the
//      failure path routes INTO the seam, not into a dead end.
//   3. `CompanionWsTransport` resolves to `not-detected` when no Companion is
//      reachable — it does not hang or throw (A14 / A12c).
//   4. `CompanionWsTransport` resolves to `mint-unavailable` when the token
//      mint fails.
//
// A14b's L2 artifact is still captured in the evidence phase — this is
// supporting evidence that the seam is genuine.

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type {
  TerminalTransport,
  TransportStatus,
} from "./terminal-transport.js";
import { FallbackTransportStub } from "./fallback-transport.stub.js";
import { CompanionWsTransport } from "./companion-ws-transport.js";
import { PanelTerminal } from "./PanelTerminal.js";
import type { Ticket } from "../lib/types";

// ── 1. Both transports satisfy the same interface ────────────────────────────

describe("TerminalTransport seam — type assignability", () => {
  it("FallbackTransportStub is assignable to TerminalTransport", () => {
    // If this stops compiling, the seam is broken.
    const stub: TerminalTransport = new FallbackTransportStub();
    expect(typeof stub.connect).toBe("function");
    expect(typeof stub.send).toBe("function");
    expect(typeof stub.resize).toBe("function");
    expect(typeof stub.close).toBe("function");
  });

  it("CompanionWsTransport is assignable to TerminalTransport", () => {
    const real: TerminalTransport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
    });
    expect(typeof real.connect).toBe("function");
    expect(typeof real.send).toBe("function");
    expect(typeof real.resize).toBe("function");
    expect(typeof real.close).toBe("function");
  });
});

// ── 2. The stub routes into the seam (degraded), not a dead end ──────────────

describe("FallbackTransportStub — defined degradation state", () => {
  it("connect() resolves to a `degraded` state", () => {
    const stub = new FallbackTransportStub();
    let last: TransportStatus | undefined;
    stub.connect({
      onFrame: () => {},
      onStatus: (s) => {
        last = s;
      },
    });
    expect(last?.state).toBe("degraded");
    stub.close();
  });

  it("send() throws — there is no Phase-2 engine behind the stub", () => {
    const stub = new FallbackTransportStub();
    stub.connect({ onFrame: () => {}, onStatus: () => {} });
    expect(() => stub.send({ t: "data", d: "ls\n" })).toThrowError(/Phase 2/);
  });

  it("resize() is a defined no-op (does not throw)", () => {
    const stub = new FallbackTransportStub();
    stub.connect({ onFrame: () => {}, onStatus: () => {} });
    expect(() => stub.resize(80, 24)).not.toThrow();
  });
});

// ── 3 & 4. The real transport degrades cleanly — no hang, no throw ───────────

describe("CompanionWsTransport — clean degradation (A14 / A12c)", () => {
  it("resolves to `not-detected` when no Companion answers /healthz", async () => {
    const transport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
      // A token mints fine, but the health probe finds nothing.
      mintToken: async () => ({
        token: "fixture.token.value",
        sessionId: "sess-fixture",
        port: 7720,
      }),
      healthProbe: async () => false,
    });

    const state = await new Promise<string>((resolve) => {
      transport.connect({
        onFrame: () => {},
        onStatus: (s) => {
          if (s.state !== "connecting") resolve(s.state);
        },
      });
    });

    expect(state).toBe("not-detected");
    transport.close();
  });

  it("resolves to `mint-unavailable` when the token mint fails", async () => {
    const transport = new CompanionWsTransport({
      ticketId: "DSP-2901",
      origin: "http://localhost:5173",
      mintToken: async () => {
        throw new Error("POST /api/companion/sessions 503");
      },
      healthProbe: async () => true,
    });

    const state = await new Promise<string>((resolve) => {
      transport.connect({
        onFrame: () => {},
        onStatus: (s) => {
          if (s.state !== "connecting") resolve(s.state);
        },
      });
    });

    expect(state).toBe("mint-unavailable");
    transport.close();
  });
});

// ── 5. PanelTerminal accepts the stub transport UNMODIFIED (A14b) ────────────

const FIXTURE_TICKET: Ticket = {
  id: "tkt-fixture-0001",
  displayId: "DSP-2901",
  accountId: "acct-fixture-0001",
  clientName: "ProRise Painting",
  clientHealth: "good",
  status: "on-you",
  type: "question",
  assignee: null,
  effortBucket: "client-specific",
  sourceKind: "channel",
  originClass: "client",
  preview: "fixture",
  ageMin: 12,
  slaMin: null,
  paused: false,
  openedAt: new Date().toISOString(),
};

/** A minimal injectable transport that resolves to a fixed state. */
class FixedStateTransport implements TerminalTransport {
  constructor(private readonly state: TransportStatus["state"]) {}
  connect(handlers: { onStatus: (s: TransportStatus) => void }): void {
    handlers.onStatus({ state: this.state });
  }
  send(): void {}
  resize(): void {}
  close(): void {}
}

describe("PanelTerminal — accepts the stub fallback transport unmodified (A14b)", () => {
  it("renders a defined `degraded` fallback block when handed the stub", async () => {
    // The whole seam proof: PanelTerminal takes a `TerminalTransport` prop. We
    // hand it the FallbackTransportStub — the SAME component, no change — and
    // it renders the defined degradation UI, not a crash, not a dead end.
    const stub: TerminalTransport = new FallbackTransportStub();
    render(<PanelTerminal ticket={FIXTURE_TICKET} transport={stub} />);

    // The degraded state's failure block is rendered (a defined fallback UI —
    // the failure path routes INTO the seam). Query the title specifically.
    const title = await screen.findByText("Running in fallback mode");
    expect(title.className).toBe("ttl");
    cleanup();
  });

  it("renders the not-detected failure block with a wired Retry (A14)", async () => {
    // When no Companion is reachable the panel must reach a clean failure
    // state with a wired Retry — it does not hang, spin, or throw.
    const transport: TerminalTransport = new FixedStateTransport("not-detected");
    render(<PanelTerminal ticket={FIXTURE_TICKET} transport={transport} />);

    expect(await screen.findByText("Companion isn't running")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /retry connection/i })
    ).toBeTruthy();
    cleanup();
  });

  it("renders the claude-unusable failure block for state (c)", async () => {
    const transport: TerminalTransport = new FixedStateTransport("claude-unusable");
    render(<PanelTerminal ticket={FIXTURE_TICKET} transport={transport} />);
    expect(await screen.findByText("Claude Code needs attention")).toBeTruthy();
    cleanup();
  });
});
