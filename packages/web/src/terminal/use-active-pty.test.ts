// dispatch — useActivePty tests (Phase 2 / Slice 6).
//
// Public-interface tests: render the hook with a fake transport + a fake
// frame-subscriber, push server frames through, assert state transitions for
// the "most recent active PTY" pointer. Spec §3.7: the data layer holds
// multiple; the UI renders one. These tests prove the pointer.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useActivePty } from "./use-active-pty.js";
import type {
  TerminalTransport,
  TransportStatus,
  PtyFrame,
} from "../ticket/terminal-transport.js";
import type { ClientFrame, ServerFrame } from "../ticket/companion-protocol.js";
import * as toastModule from "../lib/use-undoable-mutation.js";

/** Minimal fake transport — captures sent frames. */
class FakeTransport implements TerminalTransport {
  sent: ClientFrame[] = [];

  connect(_handlers: {
    onStatus: (s: TransportStatus) => void;
    onFrame: (frame: ServerFrame) => void;
  }): void {
    /* no-op */
  }

  send(frame: ClientFrame): void {
    this.sent.push(frame);
  }

  openPty(_ticketId: string): Promise<string> {
    return new Promise(() => {});
  }

  subscribe(_pty_id: string, _listener: (f: PtyFrame) => void): () => void {
    return () => {};
  }

  write(pty_id: string, data: string): void {
    this.sent.push({ t: "pty.write", pty_id, data });
  }

  resize(pty_id: string, cols: number, rows: number): void {
    this.sent.push({ t: "pty.resize", pty_id, cols, rows });
  }

  closePty(pty_id: string): void {
    this.sent.push({ t: "pty.close", pty_id });
  }

  close(): void {
    /* no-op */
  }
}

/**
 * A small frame bus that lets tests `push` server frames into whatever the
 * hook subscribes with. Matches the registration shape useCompanion exposes:
 * `(cb) => unsubscribe`.
 */
function makeFrameBus(): {
  subscribe: (cb: (frame: ServerFrame) => void) => () => void;
  push: (frame: ServerFrame) => void;
} {
  const subscribers = new Set<(frame: ServerFrame) => void>();
  return {
    subscribe: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    push: (frame) => {
      for (const cb of subscribers) cb(frame);
    },
  };
}

describe("useActivePty", () => {
  let infoToastSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoToastSpy = vi.spyOn(toastModule, "fireInfoToast");
  });

  afterEach(() => {
    cleanup();
    infoToastSpy.mockRestore();
  });

  it("starts with no active PTY and an empty list", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    const { result } = renderHook(() =>
      useActivePty("DSP-TEST", transport, bus.subscribe)
    );
    expect(result.current.activePtyId).toBeNull();
    expect(result.current.ptyList).toEqual([]);
  });

  it("sets activePtyId on first pty.opened frame", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    const { result } = renderHook(() =>
      useActivePty("DSP-TEST", transport, bus.subscribe)
    );
    act(() => {
      bus.push({ t: "pty.opened", pty_id: "pty-A" });
    });
    expect(result.current.activePtyId).toBe("pty-A");
    expect(result.current.ptyList).toEqual(["pty-A"]);
  });

  it("flips activePtyId to the newest PTY (newest-wins) while list stays plural", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    const { result } = renderHook(() =>
      useActivePty("DSP-TEST", transport, bus.subscribe)
    );
    act(() => {
      bus.push({ t: "pty.opened", pty_id: "pty-A" });
    });
    expect(result.current.activePtyId).toBe("pty-A");
    act(() => {
      bus.push({ t: "pty.opened", pty_id: "pty-B" });
    });
    expect(result.current.activePtyId).toBe("pty-B");
    expect(result.current.ptyList).toContain("pty-A");
    expect(result.current.ptyList).toContain("pty-B");
    expect(result.current.ptyList.length).toBe(2);
  });

  it("closing the active PTY falls back to the next-most-recent", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    const { result } = renderHook(() =>
      useActivePty("DSP-TEST", transport, bus.subscribe)
    );
    act(() => {
      bus.push({ t: "pty.opened", pty_id: "pty-A" });
      bus.push({ t: "pty.opened", pty_id: "pty-B" });
      bus.push({ t: "pty.opened", pty_id: "pty-C" });
    });
    expect(result.current.activePtyId).toBe("pty-C");

    // Closing the active (pty-C) → fall back to most-recent of the rest (pty-B).
    act(() => {
      bus.push({
        t: "pty.exit",
        pty_id: "pty-C",
        code: 0,
        signal: null,
      });
    });
    expect(result.current.activePtyId).toBe("pty-B");
    expect(result.current.ptyList).toEqual(
      expect.arrayContaining(["pty-A", "pty-B"])
    );
    expect(result.current.ptyList.length).toBe(2);
  });

  it("closing the last PTY leaves activePtyId null", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    const { result } = renderHook(() =>
      useActivePty("DSP-TEST", transport, bus.subscribe)
    );
    act(() => {
      bus.push({ t: "pty.opened", pty_id: "pty-A" });
    });
    act(() => {
      bus.push({
        t: "pty.exit",
        pty_id: "pty-A",
        code: 0,
        signal: null,
      });
    });
    expect(result.current.activePtyId).toBeNull();
    expect(result.current.ptyList).toEqual([]);
  });

  it("a non-active PTY exiting does not change activePtyId", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    const { result } = renderHook(() =>
      useActivePty("DSP-TEST", transport, bus.subscribe)
    );
    act(() => {
      bus.push({ t: "pty.opened", pty_id: "pty-A" });
      bus.push({ t: "pty.opened", pty_id: "pty-B" });
    });
    expect(result.current.activePtyId).toBe("pty-B");
    act(() => {
      bus.push({
        t: "pty.exit",
        pty_id: "pty-A",
        code: 0,
        signal: null,
      });
    });
    expect(result.current.activePtyId).toBe("pty-B");
    expect(result.current.ptyList).toEqual(["pty-B"]);
  });

  it("pty.error { cap-exceeded } emits a user-facing info toast", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    renderHook(() => useActivePty("DSP-TEST", transport, bus.subscribe));
    act(() => {
      bus.push({ t: "pty.error", code: "cap-exceeded" });
    });
    expect(infoToastSpy).toHaveBeenCalledTimes(1);
    const message = infoToastSpy.mock.calls[0]?.[0];
    expect(message).toMatch(/3-PTY cap/);
    expect(message).toMatch(/Close one/);
  });

  it("non-cap-exceeded errors do NOT fire the toast", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    renderHook(() => useActivePty("DSP-TEST", transport, bus.subscribe));
    act(() => {
      bus.push({
        t: "pty.error",
        code: "spawn-failed",
        detail: "execvp ENOENT",
      });
    });
    expect(infoToastSpy).not.toHaveBeenCalled();
  });

  it("openPty() sends a pty.open frame for this hook's ticketId", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    const { result } = renderHook(() =>
      useActivePty("DSP-OPEN", transport, bus.subscribe)
    );
    act(() => {
      result.current.openPty();
    });
    expect(transport.sent).toEqual([
      { t: "pty.open", ticket_id: "DSP-OPEN" },
    ]);
  });

  it("closePty(pty_id) sends a pty.close frame for that pty_id", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    const { result } = renderHook(() =>
      useActivePty("DSP-CLOSE", transport, bus.subscribe)
    );
    act(() => {
      result.current.closePty("pty-XYZ");
    });
    expect(transport.sent).toEqual([{ t: "pty.close", pty_id: "pty-XYZ" }]);
  });

  it("unsubscribes from the frame bus on unmount", () => {
    const transport = new FakeTransport();
    const bus = makeFrameBus();
    const { result, unmount } = renderHook(() =>
      useActivePty("DSP-TEST", transport, bus.subscribe)
    );
    act(() => {
      bus.push({ t: "pty.opened", pty_id: "pty-A" });
    });
    expect(result.current.activePtyId).toBe("pty-A");
    unmount();
    // After unmount, pushing more frames must NOT throw (the listener is gone).
    expect(() => bus.push({ t: "pty.opened", pty_id: "pty-Z" })).not.toThrow();
  });
});
