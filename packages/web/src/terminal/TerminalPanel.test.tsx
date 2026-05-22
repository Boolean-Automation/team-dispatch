// dispatch — TerminalPanel tests (Phase 2 / Slice 3).
//
// Public-interface tests: render the panel with an injected fake transport,
// drive it through the dock-bottom default, position toggle, close, and
// ticket-route unmount → pty.close emission.

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { TerminalPanel } from "./TerminalPanel.js";
import type {
  TerminalTransport,
  TransportStatus,
  PtyFrame,
} from "../ticket/terminal-transport.js";
import type { ClientFrame } from "../ticket/companion-protocol.js";

/**
 * A fake multi-PTY transport that drives the panel through a deterministic
 * connect → connected → pty.opened flow. Captures sent frames for assertions.
 */
class FakeTransport implements TerminalTransport {
  sent: ClientFrame[] = [];
  closedPtys: string[] = [];
  private handlers:
    | {
        onStatus: (s: TransportStatus) => void;
        onFrame: (frame: unknown) => void;
      }
    | undefined;
  private subscribers = new Map<string, Set<(f: PtyFrame) => void>>();
  /** When true, openPty resolves immediately with a fixed id. */
  private autoOpen = true;
  private nextPtyId = "pty-fake-1";

  constructor(opts?: { autoOpen?: boolean; ptyId?: string }) {
    if (opts?.autoOpen === false) this.autoOpen = false;
    if (opts?.ptyId) this.nextPtyId = opts.ptyId;
  }

  connect(handlers: {
    onStatus: (s: TransportStatus) => void;
    onFrame: (frame: unknown) => void;
  }): void {
    this.handlers = handlers;
    // Resolve `connected` with a stable epoch so useCompanion calls openPty.
    setTimeout(() => {
      this.handlers?.onStatus({
        state: "connected",
        sessionId: "sess-fake",
        companionStartedAt: 12345,
        capabilities: ["unicode11", "search"],
      });
    }, 0);
  }

  send(frame: ClientFrame): void {
    this.sent.push(frame);
  }

  openPty(_ticketId: string): Promise<string> {
    if (!this.autoOpen) {
      return new Promise(() => {});
    }
    return Promise.resolve(this.nextPtyId);
  }

  subscribe(pty_id: string, listener: (f: PtyFrame) => void): () => void {
    let set = this.subscribers.get(pty_id);
    if (!set) {
      set = new Set();
      this.subscribers.set(pty_id, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  write(pty_id: string, data: string): void {
    this.sent.push({ t: "pty.write", pty_id, data });
  }

  resize(pty_id: string, cols: number, rows: number): void {
    this.sent.push({ t: "pty.resize", pty_id, cols, rows });
  }

  closePty(pty_id: string): void {
    this.closedPtys.push(pty_id);
    this.sent.push({ t: "pty.close", pty_id });
  }

  close(): void {
    this.handlers = undefined;
  }
}

describe("TerminalPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the toolbar with launcher slot, tab pill, and action cluster", async () => {
    const transport = new FakeTransport();
    render(
      <TerminalPanel ticketId="DSP-SMOKE" transport={transport} />
    );

    // Toolbar elements.
    expect(screen.getByTestId("terminal-panel")).toBeTruthy();
    expect(screen.getByTestId("terminal-splitter")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /find in terminal/i })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /pop out terminal/i })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /close terminal/i })
    ).toBeTruthy();
    // The `+` stub is disabled.
    const plusBtn = document.querySelector(".term-act.is-stub");
    expect(plusBtn).toBeTruthy();
    expect(plusBtn?.getAttribute("aria-disabled")).toBe("true");
  });

  it("defaults to bottom-open and toggles to dock-right", async () => {
    const transport = new FakeTransport();
    render(
      <TerminalPanel ticketId="DSP-SMOKE" transport={transport} />
    );

    const panel = screen.getByTestId("terminal-panel");
    expect(panel.className).toContain("term-panel-bottom");

    // Toggle position.
    const toggleBtn = screen.getByRole("button", {
      name: /toggle panel position/i,
    });
    act(() => {
      fireEvent.click(toggleBtn);
    });
    const after = screen.getByTestId("terminal-panel");
    expect(after.className).toContain("term-panel-right");
  });

  it("close button hides the panel", () => {
    const transport = new FakeTransport();
    render(
      <TerminalPanel ticketId="DSP-SMOKE" transport={transport} />
    );
    const closeBtn = screen.getByRole("button", { name: /close terminal/i });
    act(() => {
      fireEvent.click(closeBtn);
    });
    expect(screen.queryByTestId("terminal-panel")).toBeNull();
  });

  it("emits pty.close on unmount (ticket-route leave)", async () => {
    const transport = new FakeTransport();
    const { unmount } = render(
      <TerminalPanel ticketId="DSP-SMOKE" transport={transport} />
    );

    // Wait for the connect → openPty → activePtyId pipeline to land.
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 50));
    });

    unmount();
    // Either via the explicit pty.close send or the closePty path the
    // transport's pty.close set must include the active id.
    const closedFrames = transport.sent.filter((f) => f.t === "pty.close");
    expect(closedFrames.length).toBeGreaterThanOrEqual(1);
  });
});
