// dispatch — Phase 2 / AC A6 — WebGL → Canvas fallback smoke harness.
//
// A DEV-ONLY entry that mounts the production `<Terminal>` component against a
// minimal in-memory `TerminalSubscribeTransport` so the AC A6 Playwright spec
// can drive a real WebGL→Canvas runtime flip without a Companion/WebSocket.
//
// Why this lives in `src/smoke/` and not behind a route:
//   - The SPA's `RequireAuth` + `/t/:displayId` path requires a ticket query.
//     Without a Companion the panel's runtime branches into `.term-fail` and
//     never mounts `<Terminal>` — defeating the entire purpose of the test.
//   - The slice-2 evidence used the same `smoke-*.html` + `src/smoke/*.tsx`
//     pattern to drive the original L1 capture (see slice-2-evidence.md §C).
//     The harness lived only long enough to ship the screenshots and was
//     deleted before the slice-2 commit. The retry needs the harness to be
//     permanent because the runtime test now runs on every CI build.
//
// What is exposed on window:
//   - `__dispatchTerminal.getActiveRenderer()` — returns the current
//     `activeRenderer` reported by `useTerminal` (mirrors the TerminalPanel
//     helper shape so the spec uses the same helper name).
//   - `__dispatchTerminalSmoke.pushPtyData(bytes)` — pump a `pty.data` frame
//     into the live xterm so the spec can prove the buffer survives the swap.
//
// Production safety:
//   - The smoke entry is gated on `import.meta.env.DEV`. The Vite production
//     build does not emit `smoke-webgl-fallback.html` (it's only listed in
//     `vite.config.ts` `build.rollupOptions.input` for dev — we don't list it
//     there at all, so prod skips it entirely).
//   - The `__dispatchTerminal*` window assignments only happen inside this
//     module, which only loads when the smoke HTML is fetched. No production
//     bundle leak.

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Terminal as TerminalComponent,
  type TerminalHandle,
} from "../terminal/Terminal.js";
import type {
  TerminalSubscribeTransport,
  TerminalFrame,
  TerminalFrameSubscriber,
} from "../terminal/transport-contract.js";

const SMOKE_TICKET = "DSP-A6-SMOKE";
const SMOKE_PTY = "pty-a6-smoke";

/**
 * Minimal in-memory transport. Exposes a `pushFrame` so the smoke harness can
 * pump synthetic `pty.data` frames into the running xterm.
 */
class SmokeTransport implements TerminalSubscribeTransport {
  private subs = new Map<string, Set<TerminalFrameSubscriber>>();

  subscribe(pty_id: string, sub: TerminalFrameSubscriber): () => void {
    let set = this.subs.get(pty_id);
    if (!set) {
      set = new Set();
      this.subs.set(pty_id, set);
    }
    set.add(sub);
    return () => {
      set?.delete(sub);
    };
  }

  write(_pty_id: string, _data: string): void {
    /* no-op — the smoke harness drives input from the test side */
  }

  pushFrame(frame: TerminalFrame): void {
    const set = this.subs.get(frame.pty_id);
    if (!set) return;
    for (const sub of set) sub(frame);
  }
}

interface SmokeWindowHelper {
  getActiveRenderer(): "webgl" | "canvas" | "dom";
}

interface SmokeRig {
  pushPtyData(bytes: Uint8Array | string): void;
}

function Harness(): React.ReactElement {
  const transport = useRef(new SmokeTransport());
  const termRef = useRef<TerminalHandle | null>(null);
  const [renderer, setRenderer] = useState<"webgl" | "canvas" | "dom">("dom");

  useEffect(() => {
    // Install the dev helpers BEFORE Playwright reads them. The
    // `__dispatchTerminal` shape mirrors the TerminalPanel helper so the spec
    // uses the same accessor name regardless of which surface mounts the
    // terminal (panel via Companion in handoff captures, smoke here in CI).
    const helper: SmokeWindowHelper = {
      getActiveRenderer(): "webgl" | "canvas" | "dom" {
        return termRef.current?.activeRenderer ?? "dom";
      },
    };
    const rig: SmokeRig = {
      pushPtyData(bytes: Uint8Array | string): void {
        const u8 =
          typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
        transport.current.pushFrame({
          kind: "pty.data",
          pty_id: SMOKE_PTY,
          bytes: u8,
        });
      },
    };
    (window as unknown as { __dispatchTerminal?: SmokeWindowHelper }).__dispatchTerminal =
      helper;
    (window as unknown as { __dispatchTerminalSmoke?: SmokeRig }).__dispatchTerminalSmoke =
      rig;

    return () => {
      const w = window as unknown as {
        __dispatchTerminal?: unknown;
        __dispatchTerminalSmoke?: unknown;
      };
      if (w.__dispatchTerminal === helper) delete w.__dispatchTerminal;
      if (w.__dispatchTerminalSmoke === rig) delete w.__dispatchTerminalSmoke;
    };
  }, []);

  // Poll the imperative handle each frame so the smoke HUD reflects the live
  // renderer tier. The test reads `getActiveRenderer()` directly; this HUD
  // exists only so a human running the smoke page sees what's going on.
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      const cur = termRef.current?.activeRenderer ?? "dom";
      setRenderer((prev) => (prev === cur ? prev : cur));
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      style={{
        background: "#0e0f12",
        color: "#e6e6e6",
        fontFamily: "JetBrains Mono, Menlo, monospace",
        minHeight: "100vh",
        padding: "16px",
      }}
    >
      <div
        style={{
          marginBottom: "12px",
          display: "flex",
          gap: "12px",
          alignItems: "center",
        }}
      >
        <strong data-testid="smoke-title">A6 WebGL → Canvas smoke</strong>
        <span
          data-testid="smoke-renderer"
          style={{
            padding: "2px 8px",
            borderRadius: "4px",
            background:
              renderer === "webgl"
                ? "#1e90ff33"
                : renderer === "canvas"
                  ? "#ff8c0033"
                  : "#88888833",
            border: `1px solid ${
              renderer === "webgl"
                ? "#1e90ff"
                : renderer === "canvas"
                  ? "#ff8c00"
                  : "#888888"
            }`,
          }}
        >
          renderer: {renderer}
        </span>
      </div>
      <div
        data-testid="smoke-terminal-wrap"
        style={{
          width: "1280px",
          height: "440px",
          maxWidth: "100%",
          background: "#0e0f12",
        }}
      >
        <TerminalComponent
          ref={termRef}
          ptyId={SMOKE_PTY}
          ticketId={SMOKE_TICKET}
          transport={transport.current}
        />
      </div>
    </div>
  );
}

const root = document.getElementById("smoke-root");
if (root) {
  createRoot(root).render(<Harness />);
}
