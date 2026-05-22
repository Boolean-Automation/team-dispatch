// dispatch — selection-aware Cmd/Ctrl+C / Cmd/Ctrl+V (Phase 2 / Slice 2).
//
// xterm.js by default treats Cmd/Ctrl+C as "send the SIGINT byte" (\x03). On a
// terminal embedded in a browser, that is the wrong default ~80% of the time:
// when the SE has selected text, they want to copy it; only when there is no
// selection do they want to interrupt the running process.
//
// This module installs an `attachCustomKeyEventHandler` that:
//   - Cmd/Ctrl + C, selection present → `clipboard.writeText(selection)`,
//     swallow the event (do NOT let xterm see it).
//   - Cmd/Ctrl + C, no selection → write `\x03` through the transport.
//   - Cmd/Ctrl + V → `clipboard.readText()`, write the result through the
//     transport. xterm's bracketed-paste mode (set on the `Terminal` itself)
//     wraps the bytes so shells that understand it (zsh, bash readline) see
//     the paste atomically rather than as keystrokes.
//   - Cmd+Shift+C, plain typing, etc. → returned `true` (xterm handles it).
//
// The handler returns a `dispose` fn that swaps in a noop so the chord stops
// firing once the React component unmounts.

import type { Terminal } from "@xterm/xterm";

/**
 * The minimal transport contract the key handler depends on. Decoupled from
 * the full `TerminalTransport` interface so this module is independently
 * testable.
 */
export interface TerminalWriteTransport {
  write(pty_id: string, data: string): void;
}

export interface KeyHandlerOptions {
  /**
   * Injection point for the navigator.clipboard API — lets tests run without
   * a real Clipboard. Defaults to `navigator.clipboard` at install time.
   */
  clipboard?: Clipboard;
}

/**
 * Install the Cmd/Ctrl+C/V handler on `term`. Returns a `dispose` fn that
 * neuters the handler when the component unmounts.
 */
export function installKeyHandler(
  term: Pick<Terminal, "attachCustomKeyEventHandler" | "getSelection">,
  transport: TerminalWriteTransport,
  ptyId: string,
  options: KeyHandlerOptions = {}
): () => void {
  const clipboard: Clipboard | undefined =
    options.clipboard ??
    (typeof navigator !== "undefined" ? navigator.clipboard : undefined);

  let disposed = false;

  function handler(ev: KeyboardEvent): boolean {
    if (disposed) return true;
    // We only intercept keydown events. Browsers may fire keypress/keyup on
    // the same chord; xterm only routes keydown through the custom handler.
    if (ev.type !== "keydown") return true;

    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod) return true;
    if (ev.shiftKey) return true; // leave Cmd+Shift+C etc. alone

    const key = ev.key.toLowerCase();

    if (key === "c") {
      const sel = term.getSelection();
      if (sel.length > 0) {
        // Fire-and-forget clipboard write. The shell isn't interrupted —
        // exactly the behavior the SE expects when they have a selection.
        if (clipboard) {
          void clipboard.writeText(sel).catch(() => {
            /* clipboard denied or unavailable — silently degrade */
          });
        }
        return false;
      }
      // No selection → SIGINT through the transport.
      transport.write(ptyId, "\x03");
      return false;
    }

    if (key === "v") {
      if (clipboard) {
        void clipboard
          .readText()
          .then((text) => {
            if (disposed) return;
            // Empty paste = no-op; non-empty rides bracketed-paste through xterm.
            if (text.length > 0) transport.write(ptyId, text);
          })
          .catch(() => {
            /* clipboard read denied — silently degrade. The SE's existing
             * Cmd+V is the only path; if it fails, no surface to handle. */
          });
      }
      return false;
    }

    return true;
  }

  term.attachCustomKeyEventHandler(handler);

  return function dispose() {
    disposed = true;
    // Reattach a noop so any handler-tied closure no longer runs.
    term.attachCustomKeyEventHandler(() => true);
  };
}
