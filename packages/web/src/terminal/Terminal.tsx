// dispatch — Terminal component (Phase 2 / Slice 2).
//
// A self-contained xterm.js host. Slice 3 mounts this inside `TerminalPanel`
// (the bottom-dock / dock-right surface), Slice 3's popout window mounts a
// second instance against the opener's transport — same component, same hook,
// different transport source.
//
// What this component owns:
//   - The xterm Terminal instance, the 6 addons, the JetBrains Mono ligatures.
//   - Subscribing to PTY frames for the given pty_id.
//   - Replaying scrollback from IndexedDB before live frames render.
//   - Selection-aware Cmd/Ctrl+C/V via the key handler.
//   - Exposing search/fit/term via an imperative ref for parent control.
//
// What this component does NOT own (S3+):
//   - The dock chrome (toolbar, resize handle, popout button, position).
//   - Token mint, WebSocket lifecycle, session handshake — that lives in the
//     transport (Slice 3 wires the singleton; this component only consumes).

import React, { forwardRef, useImperativeHandle } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";

import { useTerminal } from "./use-terminal.js";
import type { ThemeName } from "./themes.js";
import type { TerminalSubscribeTransport } from "./transport-contract.js";

/** Props the Terminal component accepts. */
export interface TerminalProps {
  /** The PTY this terminal renders. */
  ptyId: string;
  /** The ticket the panel belongs to — scopes the scrollback partition. */
  ticketId: string;
  /** The transport — Slice 3 supplies a window-global singleton. */
  transport: TerminalSubscribeTransport;
  /** Theme name. Defaults to `coal`. */
  themeName?: ThemeName;
  /** Font size in px. Default 13. */
  fontSize?: number;
  /** Optional className for the host div (the panel may set sizing classes). */
  className?: string;
}

/** Imperative API the parent (S3 panel / popout) can drive. */
export interface TerminalHandle {
  /** The active xterm Terminal instance, or null before mount. */
  term: XTerm | null;
  /** The search addon — drives S3's find overlay. */
  searchAddon: SearchAddon | null;
  /** Call FitAddon.fit() — used after drag-resize finishes. */
  fit(): void;
  /** Convenience: SearchAddon.findNext on the active search. */
  findNext(query: string): void;
  /** Convenience: SearchAddon.findPrevious. */
  findPrevious(query: string): void;
}

/**
 * The Terminal component.
 *
 * The `forwardRef` exposes the imperative `TerminalHandle` so S3's panel and
 * popout can drive search + fit without re-implementing the lifecycle.
 */
export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal(
    { ptyId, ticketId, transport, themeName, fontSize, className }: TerminalProps,
    ref
  ) {
    const { containerRef, term, searchAddon, fit } = useTerminal({
      ptyId,
      ticketId,
      transport,
      themeName,
      fontSize,
    });

    useImperativeHandle(
      ref,
      (): TerminalHandle => ({
        term,
        searchAddon,
        fit,
        findNext(query: string) {
          try {
            searchAddon?.findNext(query);
          } catch {
            /* addon not yet loaded */
          }
        },
        findPrevious(query: string) {
          try {
            searchAddon?.findPrevious(query);
          } catch {
            /* addon not yet loaded */
          }
        },
      }),
      [term, searchAddon, fit]
    );

    return (
      <div
        className={className ?? "term-stage"}
        // The xterm-host class is the existing Phase-1 mount rule — keeps
        // overflow/width/height behaviour aligned with the spike CSS.
        // S3 may swap this for `.term-stage`; for now this is the
        // self-contained component, so a host wrapper is the safer default.
      >
        <div ref={containerRef} className="xterm-host" />
      </div>
    );
  }
);
