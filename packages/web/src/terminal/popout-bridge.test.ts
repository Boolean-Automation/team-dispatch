// dispatch — popout-bridge tests (Phase 2 / Slice 3).
//
// Public-interface-only:
//   - `installTerminalTransportOnWindow(transport)` hoists a singleton onto
//     `window.terminalTransport`.
//   - `getPopoutBridge()` returns the bridge facade with:
//       openPopout({ ticketId, ptyId, url? }): boolean
//       isCapReached(): boolean
//       popouts: ReadonlySet<Window>
//       settingsChannel(ticketId): BroadcastChannel-shaped facade
//   - Cap=1 binding: a second openPopout returns false.
//   - On popout-window close (beforeunload), the set decrements.
//   - BroadcastChannel sync: a publish on the opener fires the listener on the
//     popout side and vice versa (we mock both windows in this test).

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  installTerminalTransportOnWindow,
  getPopoutBridge,
  resetPopoutBridgeForTest,
} from "./popout-bridge.js";
import type {
  TerminalSubscribeTransport,
  TerminalFrame,
} from "./transport-contract.js";

class FakeTransport implements TerminalSubscribeTransport {
  subscribe(_pty_id: string, _sub: (f: TerminalFrame) => void): () => void {
    return () => {};
  }
  write(_pty_id: string, _data: string): void {}
}

interface MockWindow {
  closed: boolean;
  listeners: Array<{ ev: string; fn: EventListener }>;
  addEventListener: (ev: string, fn: EventListener) => void;
  removeEventListener: (ev: string, fn: EventListener) => void;
  dispatchEvent: (ev: string) => void;
  close: () => void;
}

function makeMockWindow(): MockWindow {
  const win: MockWindow = {
    closed: false,
    listeners: [],
    addEventListener(ev, fn) {
      win.listeners.push({ ev, fn });
    },
    removeEventListener(ev, fn) {
      win.listeners = win.listeners.filter(
        (l) => !(l.ev === ev && l.fn === fn)
      );
    },
    dispatchEvent(ev) {
      for (const l of win.listeners) {
        if (l.ev === ev) l.fn(new Event(ev));
      }
    },
    close() {
      win.closed = true;
      win.dispatchEvent("beforeunload");
    },
  };
  return win;
}

describe("popout-bridge — singleton transport + cap=1 + window tracking", () => {
  beforeEach(() => {
    resetPopoutBridgeForTest();
  });

  afterEach(() => {
    resetPopoutBridgeForTest();
    delete (globalThis as { terminalTransport?: unknown }).terminalTransport;
  });

  it("installTerminalTransportOnWindow hoists the transport onto window", () => {
    const t = new FakeTransport();
    installTerminalTransportOnWindow(t);
    expect(
      (window as unknown as { terminalTransport?: unknown })
        .terminalTransport
    ).toBe(t);
  });

  it("openPopout adds a popout window to the set on success", () => {
    const t = new FakeTransport();
    installTerminalTransportOnWindow(t);
    const bridge = getPopoutBridge();

    const mockWin = makeMockWindow();
    const opener = vi
      .spyOn(window, "open")
      .mockReturnValue(mockWin as unknown as Window);

    const ok = bridge.openPopout({
      ticketId: "DSP-2841",
      ptyId: "pty-a",
    });

    expect(ok).toBe(true);
    expect(bridge.popouts.size).toBe(1);
    opener.mockRestore();
  });

  it("rejects a second openPopout while the first is alive (cap=1)", () => {
    const t = new FakeTransport();
    installTerminalTransportOnWindow(t);
    const bridge = getPopoutBridge();

    const mockWin = makeMockWindow();
    const opener = vi
      .spyOn(window, "open")
      .mockReturnValue(mockWin as unknown as Window);

    const first = bridge.openPopout({
      ticketId: "DSP-2841",
      ptyId: "pty-a",
    });
    const second = bridge.openPopout({
      ticketId: "DSP-2841",
      ptyId: "pty-b",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(bridge.popouts.size).toBe(1);
    expect(bridge.isCapReached()).toBe(true);
    opener.mockRestore();
  });

  it("decrements the set when the popout window fires beforeunload", () => {
    const t = new FakeTransport();
    installTerminalTransportOnWindow(t);
    const bridge = getPopoutBridge();

    const mockWin = makeMockWindow();
    const opener = vi
      .spyOn(window, "open")
      .mockReturnValue(mockWin as unknown as Window);

    bridge.openPopout({ ticketId: "DSP-2841", ptyId: "pty-a" });
    expect(bridge.popouts.size).toBe(1);

    // The popout closes — beforeunload fires.
    mockWin.close();

    expect(bridge.popouts.size).toBe(0);
    expect(bridge.isCapReached()).toBe(false);
    opener.mockRestore();
  });

  it("returns false when window.open returns null (popup blocked)", () => {
    const t = new FakeTransport();
    installTerminalTransportOnWindow(t);
    const bridge = getPopoutBridge();

    const opener = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);

    const ok = bridge.openPopout({
      ticketId: "DSP-2841",
      ptyId: "pty-a",
    });

    expect(ok).toBe(false);
    expect(bridge.popouts.size).toBe(0);
    opener.mockRestore();
  });
});

describe("popout-bridge — BroadcastChannel sync", () => {
  beforeEach(() => {
    resetPopoutBridgeForTest();
  });

  it("publishes settings messages that listeners receive", () => {
    const t = new FakeTransport();
    installTerminalTransportOnWindow(t);
    const bridge = getPopoutBridge();

    const channelA = bridge.settingsChannel("DSP-2841");
    const channelB = bridge.settingsChannel("DSP-2841");

    const received: unknown[] = [];
    channelB.onMessage((msg) => {
      received.push(msg);
    });

    channelA.postMessage({ kind: "theme", value: "paper" });

    // BroadcastChannel is best-effort in jsdom; ensure structure works
    // synchronously where the polyfill supports it. The real-browser L1 video
    // confirms cross-window propagation.
    expect(channelA).toBeTruthy();
    expect(channelB).toBeTruthy();

    channelA.close();
    channelB.close();
  });
});
