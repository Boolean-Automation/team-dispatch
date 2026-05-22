// dispatch — useTerminal hook (Phase 2 / Slice 2).
//
// Owns the xterm.js lifecycle: construct the `Terminal`, load the 6 addons in
// the PROVEN order (Unicode11 → WebLinks → Serialize → Search → Ligatures →
// WebGL — see prototype/findings.md probe 1), wire subscribe + write +
// scrollback replay, debounced scrollback append, dispose on unmount.
//
// Exposed via a ref so the panel (S3) can call `.fit()` on resize and the
// popout (S3) can reuse the same hook against an existing subscribe target.

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import { SearchAddon } from "@xterm/addon-search";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { scrollbackStore } from "./scrollback-store.js";
import { installKeyHandler } from "./key-handler.js";
import { themes, type ThemeName, DEFAULT_THEME } from "./themes.js";
import type {
  TerminalSubscribeTransport,
  TerminalFrame,
} from "./transport-contract.js";

/** Props that drive the hook. */
export interface UseTerminalOptions {
  /** The PTY this terminal renders. */
  ptyId: string;
  /** The ticket the panel belongs to — scopes the scrollback partition. */
  ticketId: string;
  /** The transport the hook subscribes to. Required (S3 supplies the singleton). */
  transport: TerminalSubscribeTransport;
  /** Theme name. Defaults to `coal` per visual-spec §4.2. */
  themeName?: ThemeName;
  /** Font size in px. Visual-spec §4.2 default = 13 (12 in spec, 13 in S2 instructions). */
  fontSize?: number;
  /** Override `term.write` for testing — defaults to the real Terminal method. */
  writeOverride?: (term: Terminal, bytes: Uint8Array | string) => void;
}

/** What the hook returns. The component uses `containerRef` to host xterm. */
export interface UseTerminalResult {
  /** Attach this to the DOM element xterm should mount into. */
  containerRef: (el: HTMLDivElement | null) => void;
  /** The active xterm Terminal instance. Null before mount, after dispose. */
  term: Terminal | null;
  /** The search addon — exposed for find-overlay wiring (S3). */
  searchAddon: SearchAddon | null;
  /** The fit addon — exposed for the resize panel (S3). */
  fitAddon: FitAddon | null;
  /** Convenience: call FitAddon.fit() (no-op if not yet mounted). */
  fit: () => void;
}

/**
 * Debounced scrollback flusher.
 *
 * The naive "append on every pty.data frame" pattern would issue an IndexedDB
 * write per frame — for an interactive shell that's tens per second, which is
 * fine for IDB but wasteful. The compromise: batch into a buffer, flush every
 * 100ms OR when the buffer crosses 16 KB.
 */
const FLUSH_INTERVAL_MS = 100;
const FLUSH_BYTE_THRESHOLD = 16 * 1024;

function createScrollbackFlusher(ticketId: string, ptyId: string) {
  let buffer: Uint8Array[] = [];
  let bufferBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function flush(): void {
    if (disposed || buffer.length === 0) return;
    const merged = new Uint8Array(bufferBytes);
    let offset = 0;
    for (const part of buffer) {
      merged.set(part, offset);
      offset += part.length;
    }
    buffer = [];
    bufferBytes = 0;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    void scrollbackStore.append(ticketId, ptyId, merged).catch(() => {
      /* IDB write failure is non-fatal — the next flush will try again, and the
       * xterm in-memory scrollback covers the gap. */
    });
  }

  function add(bytes: Uint8Array): void {
    if (disposed || bytes.length === 0) return;
    buffer.push(bytes);
    bufferBytes += bytes.length;
    if (bufferBytes >= FLUSH_BYTE_THRESHOLD) {
      flush();
      return;
    }
    if (timer === null) {
      timer = setTimeout(flush, FLUSH_INTERVAL_MS);
    }
  }

  function dispose(): void {
    if (disposed) return;
    flush();
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { add, flush, dispose };
}

/**
 * useTerminal — the xterm lifecycle hook factored out of Terminal.tsx so the
 * popout (S3) can reuse it against `window.opener.terminalTransport`.
 *
 * Mount order (per prototype findings.md probe 1):
 *   1. Construct the Terminal with the locked options.
 *   2. Load Unicode11Addon FIRST (registers wide-glyph widths before any cell
 *      render).
 *   3. Load WebLinksAddon, SerializeAddon, SearchAddon (renderer-agnostic).
 *   4. Load LigaturesAddon (registers cell joiners before the renderer caches
 *      glyph shapes).
 *   5. term.open(container).
 *   6. Load WebglAddon LAST (renderer takes the cell content as-authored).
 *   7. Load FitAddon (an axis-aware tool, not a renderer — loads any time).
 *   8. Read prior scrollback from IndexedDB, write it into the buffer.
 *   9. Subscribe to live frames; install the key handler; wire onData.
 */
export function useTerminal(opts: UseTerminalOptions): UseTerminalResult {
  // The instances live in state so consumers re-render when they materialize.
  // `instanceVersion` is a counter that ticks once per (container-attached →
  // term-mounted) cycle to force a single re-render at the right moment.
  const [instances, setInstances] = useState<{
    term: Terminal | null;
    searchAddon: SearchAddon | null;
    fitAddon: FitAddon | null;
  }>({ term: null, searchAddon: null, fitAddon: null });

  const containerEl = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // Latest opts in a ref so callbacks see them without re-mounting the hook.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Container ref callback. React invokes it once with the element on mount
  // and once with null on unmount; we use it to trigger the effect by bumping
  // `tick`.
  const [tick, setTick] = useState(0);
  const containerRef = useCallback((el: HTMLDivElement | null): void => {
    if (containerEl.current === el) return; // ref-call idempotent
    containerEl.current = el;
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const host = containerEl.current;
    if (!host) return;
    // StrictMode-safe: if a previous run hung an xterm DOM child off this host
    // and the cleanup didn't fully remove it, clear it now so .open() starts
    // from a clean slate.
    while (host.firstChild) host.removeChild(host.firstChild);

    const themeName = optsRef.current.themeName ?? DEFAULT_THEME;
    const theme = themes[themeName];
    const fontSize = optsRef.current.fontSize ?? 13;

    const xtermOptions: ITerminalOptions = {
      fontFamily: "'JetBrains Mono', 'Menlo', monospace",
      fontSize,
      lineHeight: 1.4,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10_000,
      allowProposedApi: true,
      allowTransparency: false,
      convertEol: false,
      theme,
    };

    const term = new Terminal(xtermOptions);

    // Enable bracketed-paste mode so pasted content rides as a single chunk
    // to the shell rather than as individual keystrokes (zsh/bash readline
    // honor this; legacy shells fall back to raw bytes). xterm@6 removed
    // the `fontLigatures` option — ligature rendering is fully driven by the
    // `@xterm/addon-ligatures` package (loaded below) per OQ-9 resolution.
    try {
      // bracketed-paste mode toggle. xterm 6 sets this via DECSET 2004 — we
      // write the escape directly so it's set the moment xterm opens.
      term.write("\x1b[?2004h");
    } catch {
      /* terminal not yet open — the escape is queued and lands on open() */
    }

    // 1. Unicode11Addon — registers wide-glyph widths BEFORE any render.
    let unicodeError: unknown = null;
    try {
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11";
    } catch (err) {
      unicodeError = err;
      // Non-fatal — xterm's built-in v6 unicode handling is acceptable fallback.
    }

    // 2. WebLinksAddon — Cmd/Ctrl-click on URLs.
    try {
      term.loadAddon(new WebLinksAddon());
    } catch {
      /* non-fatal */
    }

    // 3. SerializeAddon — used by S3 for popout-transfer / scrollback dump.
    try {
      term.loadAddon(new SerializeAddon());
    } catch {
      /* non-fatal */
    }

    // 4. SearchAddon — exposed via state so the S3 find overlay can drive it.
    const searchAddon = new SearchAddon();
    try {
      term.loadAddon(searchAddon);
    } catch {
      /* non-fatal */
    }

    // 5. LigaturesAddon — must register joiners BEFORE WebGL caches glyph shapes.
    try {
      term.loadAddon(new LigaturesAddon());
    } catch {
      /* non-fatal — fontLigatures: true is set as a fallback intent */
    }

    // 6. term.open() — mount into the DOM before WebGL.
    term.open(host);

    // 7. WebglAddon LAST — renderer takes the cell content as authored above.
    let webglError: unknown = null;
    try {
      const webgl = new WebglAddon();
      // Context-loss handler: detach the addon; xterm falls back to DOM renderer.
      webgl.onContextLoss(() => {
        try {
          webgl.dispose();
        } catch {
          /* already disposed */
        }
      });
      term.loadAddon(webgl);
    } catch (err) {
      webglError = err;
      // Continue with the DOM renderer — xterm transparently falls back.
    }

    // 8. FitAddon — for the resize panel (S3).
    const fit = new FitAddon();
    try {
      term.loadAddon(fit);
      fit.fit();
      fitRef.current = fit;
    } catch {
      /* non-fatal */
    }

    // Publish instances exactly once — consumers (Terminal component) will
    // re-render with the populated handle. The effect does NOT re-fire because
    // the only effect dep is `tick`, which `setInstances` does not modify.
    setInstances({ term, searchAddon, fitAddon: fit });

    // 9. Replay scrollback BEFORE subscribing. We want the SE to see history
    // immediately on mount; live frames that arrive during the read are
    // queued by the subscribe (set up below) but drained AFTER replay.
    let liveStarted = false;
    let isDisposed = false;
    const queuedFrames: TerminalFrame[] = [];

    void scrollbackStore
      .getRecent(optsRef.current.ticketId, optsRef.current.ptyId)
      .then((replay) => {
        if (isDisposed) return; // cleanup ran before the IDB read resolved
        if (replay.length > 0) {
          term.write(replay);
        }
        // Drain anything that arrived during the read.
        for (const frame of queuedFrames) {
          if (frame.kind === "pty.data") {
            term.write(frame.bytes);
            flusher.add(frame.bytes);
          } else if (frame.kind === "pty.exit") {
            term.write(
              `\r\n\x1b[2m[Shell exited${frame.code === 0 ? "" : ` — code ${frame.code}`}]\x1b[0m\r\n`
            );
          }
        }
        queuedFrames.length = 0;
        liveStarted = true;
      })
      .catch(() => {
        // IDB read failed — just start live streaming.
        liveStarted = true;
      });

    // Scrollback flusher (debounced IDB writes).
    const flusher = createScrollbackFlusher(
      optsRef.current.ticketId,
      optsRef.current.ptyId
    );

    // 10. Subscribe to live frames.
    const unsubscribe = optsRef.current.transport.subscribe(
      optsRef.current.ptyId,
      (frame) => {
        if (!liveStarted) {
          queuedFrames.push(frame);
          return;
        }
        if (frame.kind === "pty.data") {
          term.write(frame.bytes);
          flusher.add(frame.bytes);
        } else if (frame.kind === "pty.exit") {
          term.write(
            `\r\n\x1b[2m[Shell exited${frame.code === 0 ? "" : ` — code ${frame.code}`}]\x1b[0m\r\n`
          );
        }
      }
    );

    // 11. Keystroke handler — xterm.onData fires for every char the user types.
    const dataDisposable = term.onData((d) => {
      optsRef.current.transport.write(optsRef.current.ptyId, d);
    });

    // 12. Cmd/Ctrl+C/V key handler.
    const keyDispose = installKeyHandler(
      term,
      { write: optsRef.current.transport.write.bind(optsRef.current.transport) },
      optsRef.current.ptyId
    );

    // Log non-fatal addon errors once for visibility during dev. These are
    // captured at load time above and surfaced here as console warnings — they
    // don't block the terminal from rendering.
    if (unicodeError) {
      console.warn("[useTerminal] Unicode11Addon failed to load", unicodeError);
    }
    if (webglError) {
      console.warn("[useTerminal] WebglAddon failed to load — falling back", webglError);
    }

    return () => {
      isDisposed = true;
      unsubscribe();
      dataDisposable.dispose();
      keyDispose();
      flusher.dispose();
      try {
        term.dispose();
      } catch {
        /* already disposed */
      }
      fitRef.current = null;
      setInstances({ term: null, searchAddon: null, fitAddon: null });
    };
    // tick triggers the effect when the container ref attaches; the other
    // values come from optsRef so the hook doesn't re-mount on prop changes.
  }, [tick]);

  function fit(): void {
    try {
      fitRef.current?.fit();
    } catch {
      /* host detached */
    }
  }

  return {
    containerRef,
    term: instances.term,
    searchAddon: instances.searchAddon,
    fitAddon: instances.fitAddon,
    fit,
  };
}
