// dispatch — LauncherButton tests (Phase 2 / Slice 4).
//
// Tests (binding from the slice plan):
//   1. Default label "Claude" when no Clerk metadata is present.
//   2. Custom Clerk metadata renders the custom label (via override prop —
//      the production read path is exercised in production; the override
//      seam is what S5's consent flow uses, so we test it here).
//   3. Click writes `command + \r` to the transport via send({t:'pty.write',...}).
//   4. Click also POSTs the audit endpoint with a HASHED (not raw) command.
//   5. Audit POST failure does NOT block the PTY write.
//   6. Disabled when activePtyId is null.

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { LauncherButton } from "./launcher-button.js";
import type {
  TerminalTransport,
  TransportStatus,
  PtyFrame,
} from "../ticket/terminal-transport.js";
import type { ClientFrame } from "../ticket/companion-protocol.js";

/** A minimal transport stub that captures sent frames. */
class StubTransport implements TerminalTransport {
  sent: ClientFrame[] = [];

  connect(_handlers: {
    onStatus: (s: TransportStatus) => void;
    onFrame: (frame: unknown) => void;
  }): void {
    /* no-op */
  }

  send(frame: ClientFrame): void {
    this.sent.push(frame);
  }

  openPty(_ticketId: string): Promise<string> {
    return Promise.resolve("pty-test");
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

  close(): void {}
}

/** A deterministic digest stub — returns a known 32-byte ArrayBuffer. */
function makeDigestStub() {
  // 32 bytes — the actual bytes don't matter for the test; we assert on
  // length + hex shape of the resulting hex string.
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = i;
  return vi.fn(
    async (_alg: AlgorithmIdentifier, _data: BufferSource) =>
      bytes.buffer as ArrayBuffer
  );
}

afterEach(() => {
  cleanup();
});

describe("LauncherButton", () => {
  it("renders the default 'Claude' label when no override is given", () => {
    const transport = new StubTransport();
    render(
      <LauncherButton
        activePtyId="pty-1"
        ticketDisplayId="DSP-2841"
        transport={transport}
        fetchImpl={vi.fn().mockResolvedValue(new Response(null, { status: 204 }))}
        digestImpl={makeDigestStub()}
      />
    );
    expect(screen.getByTestId("terminal-launcher").textContent).toContain(
      "Claude"
    );
  });

  it("renders the custom label when an override is provided (S5 consent flow)", () => {
    const transport = new StubTransport();
    render(
      <LauncherButton
        activePtyId="pty-1"
        ticketDisplayId="DSP-2841"
        transport={transport}
        override={{ label: "codex", command: "codex" }}
        fetchImpl={vi.fn().mockResolvedValue(new Response(null, { status: 204 }))}
        digestImpl={makeDigestStub()}
      />
    );
    expect(screen.getByTestId("terminal-launcher").textContent).toContain(
      "codex"
    );
  });

  it("writes `command + \\r` bytes to the transport on click", async () => {
    const transport = new StubTransport();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(
      <LauncherButton
        activePtyId="pty-1"
        ticketDisplayId="DSP-2841"
        transport={transport}
        override={{ label: "Claude", command: "claude" }}
        fetchImpl={fetchMock}
        digestImpl={makeDigestStub()}
      />
    );

    fireEvent.click(screen.getByTestId("terminal-launcher"));

    await waitFor(() => {
      const writes = transport.sent.filter((f) => f.t === "pty.write");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toEqual({
        t: "pty.write",
        pty_id: "pty-1",
        data: "claude\r",
      });
    });
  });

  it("POSTs the audit endpoint with a hashed (not raw) command", async () => {
    const transport = new StubTransport();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const digestStub = makeDigestStub();

    render(
      <LauncherButton
        activePtyId="pty-1"
        ticketDisplayId="DSP-2841"
        transport={transport}
        override={{ label: "Claude", command: "claude" }}
        fetchImpl={fetchMock}
        digestImpl={digestStub}
      />
    );

    fireEvent.click(screen.getByTestId("terminal-launcher"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    // Confirm the digest was called for SHA-256 with the command bytes.
    expect(digestStub).toHaveBeenCalledTimes(1);
    expect(digestStub.mock.calls[0]![0]).toBe("SHA-256");

    // Confirm the POST body is the hashed shape — NOT the raw command.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/audit/launcher-fired");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      ticket_display_id: string;
      command_hash: string;
      label: string;
    };
    expect(body.ticket_display_id).toBe("DSP-2841");
    expect(body.label).toBe("Claude");
    // The hash is 64 hex chars (32 bytes * 2 chars/byte).
    expect(body.command_hash).toMatch(/^[0-9a-f]{64}$/);
    // The raw command MUST NOT appear anywhere in the body.
    expect(init.body).not.toContain("claude");
  });

  it("does NOT block the PTY write when the audit POST fails", async () => {
    const transport = new StubTransport();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    render(
      <LauncherButton
        activePtyId="pty-1"
        ticketDisplayId="DSP-2841"
        transport={transport}
        override={{ label: "Claude", command: "claude" }}
        fetchImpl={fetchMock}
        digestImpl={makeDigestStub()}
      />
    );

    fireEvent.click(screen.getByTestId("terminal-launcher"));

    // The PTY write happens synchronously inside `fire()` — it must land
    // regardless of the audit POST outcome.
    await waitFor(() => {
      const writes = transport.sent.filter((f) => f.t === "pty.write");
      expect(writes).toHaveLength(1);
    });
  });

  it("is disabled when activePtyId is null", () => {
    const transport = new StubTransport();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    render(
      <LauncherButton
        activePtyId={null}
        ticketDisplayId="DSP-2841"
        transport={transport}
        fetchImpl={fetchMock}
        digestImpl={makeDigestStub()}
      />
    );

    const btn = screen.getByTestId("terminal-launcher") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(btn);
    // No frame sent, no POST issued.
    expect(transport.sent).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
