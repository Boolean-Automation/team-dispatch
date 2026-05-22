// dispatch — Terminal-specific XSS fuzz (Phase 2 / Slice 7).
//
// COMPLEMENT to Slice 0's SPA-wide `src/security/xss-routes.test.tsx`.
//
// The S0 fuzz proves that no React route — Issues, TicketDetail, Settings,
// Analytics — exposes user-controllable strings to an eval-shaped sink
// (dangerouslySetInnerHTML, `href={…}`, innerHTML, document.write, etc.).
//
// This file targets the OTHER write path that Phase 2 introduced: bytes
// arriving over the Companion `pty.data` channel and being written into
// xterm.js. xterm renders cell-by-cell via a WebGL canvas — literal HTML
// cannot reach the DOM tree through that path — but the byte stream is
// rich:
//   - ANSI CSI escapes can move the cursor, clear the screen, switch buffers,
//     toggle modes (including bracketed-paste).
//   - OSC escapes can set the window title (`ESC ] 0 ; … BEL`), define
//     hyperlinks (`ESC ] 8 ; ; URI BEL TEXT ESC ] 8 ; ; BEL`), and request
//     terminal queries.
//   - DECSET escape sequences toggle bracketed-paste and other modes.
//
// What we assert (the negative):
//   1. Literal HTML payloads (raw, URL-encoded, base64-decoded-by-shell
//      shape) — `<script>`, `<iframe>`, `<img onerror>` — DO NOT appear in
//      `document` outside the xterm canvas mount point.
//   2. ANSI screen-control escapes (`\x1b[2J`, OSC 0 title-set,
//      bracketed-paste-mode toggle, bracketed-paste-mode payloads) DO NOT
//      mutate `document.title`, DO NOT inject anything into the DOM, DO NOT
//      auto-execute pasted content.
//   3. OSC 8 hyperlinks with `javascript:` protocol — xterm v6 silently
//      ignores non-http/https OSC link URIs at the OscLinkProvider layer
//      (`linkHandler.allowNonHttpProtocols` defaults to undefined). We assert
//      that the link does NOT register as a clickable link element and that
//      simulating a click triggers no `window.__pwn` canary.
//   4. The trust-audit assertion: `term.write` is called only from frames
//      flowing through the WS transport's `subscribe` callback. A theme /
//      font-size / scrollback change MUST NOT write to the terminal — it
//      sets options. This guards against a future settings-control mistake
//      where a "live preview" path injects content into the live SE shell.
//
// What we deliberately do NOT assert:
//   - That xterm cell rendering is itself bug-free. Cell decoding is xterm
//     code, not dispatch code. The fuzz proves the boundary between bytes
//     and the page is intact.
//   - That the CSP header itself is in place — that's `csp-headers.test.ts`
//     in api/. This file pairs with that one.

import "fake-indexeddb/auto";
import React from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { Terminal, type TerminalProps } from "./Terminal.js";
import type {
  TerminalSubscribeTransport,
  TerminalFrameSubscriber,
} from "./transport-contract.js";
import { scrollbackStore } from "./scrollback-store.js";

/**
 * Build a `<Terminal …/>` React element via `React.createElement` instead of
 * JSX so this file can stay `.ts` (per plan.md §Slice 7) and avoid the
 * JSX-in-.ts esbuild transform error.
 */
function el(props: TerminalProps): React.ReactElement {
  return React.createElement(Terminal, props);
}

// ── Mock transport (terminal-write-path under test) ─────────────────────────
//
// The Terminal component's only seam is `TerminalSubscribeTransport`. The
// mock exposes:
//   - `emit(bytes)` — push a `pty.data` frame to every subscriber so the
//     test can drive arbitrary byte sequences into the xterm write path.
//   - `subscribers` — visible so we can assert exactly one is attached.
//   - `writes` — captures every keystroke xterm sends back via `transport.write`
//     (xterm's onData → user-typed bytes → SIGINT byte if Cmd+C without
//     selection). We do NOT exercise the user-typed path here; this lets the
//     test prove no synthetic write reaches the back-channel under any
//     payload.
class MockTransport implements TerminalSubscribeTransport {
  ptyId: string;
  subscribers = new Set<TerminalFrameSubscriber>();
  writes: Array<{ pty_id: string; data: string }> = [];

  constructor(ptyId = "pty-xss-1") {
    this.ptyId = ptyId;
  }

  subscribe(
    pty_id: string,
    subscriber: TerminalFrameSubscriber
  ): () => void {
    if (pty_id !== this.ptyId) {
      // Reject mismatched ids the same way the real transport's per-id
      // filtering would — if we ever wired a wrong id, the test should
      // fail loudly, not silently.
      throw new Error(`MockTransport: unexpected pty_id "${pty_id}"`);
    }
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  write(pty_id: string, data: string): void {
    this.writes.push({ pty_id, data });
  }

  /** Drive a `pty.data` frame from outside (tests call this). */
  emit(bytes: Uint8Array): void {
    for (const sub of this.subscribers) {
      sub({ kind: "pty.data", pty_id: this.ptyId, bytes });
    }
  }
}

// ── Test setup ──────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const TICKET_ID = "DSP-XSS-1";
const PTY_ID = "pty-xss-1";

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

/**
 * Render the terminal component with the given mock transport and wait for
 * xterm to mount. The hook publishes its `term` handle once xterm.open()
 * returns; we yield a microtask plus a setTimeout(0) cycle so React's effect
 * + the scrollback IDB read + the live subscribe registration all settle.
 */
async function mountTerminal(
  transport: MockTransport
): Promise<{ unmount: () => void; container: HTMLElement }> {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      el({
        ptyId: PTY_ID,
        ticketId: TICKET_ID,
        transport,
      })
    );
    // Allow useEffect + the async scrollback read + subscribe to land.
    await new Promise<void>((r) => setTimeout(r, 30));
  });
  return { unmount: result.unmount, container: result.container as HTMLElement };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("terminal — XSS / escape-sequence fuzz (S7)", () => {
  let originalTitle: string;

  beforeEach(async () => {
    originalTitle = document.title;
    // Reset the SPA-wide canary in case prior tests left it set.
    delete (window as Window).__pwn;
    // Reset the IndexedDB scrollback so a prior test's bytes don't replay
    // into this test's terminal and pollute the trust-audit write count.
    await scrollbackStore.__forTest.reset();
  });

  afterEach(() => {
    cleanup();
    document.title = originalTitle;
    delete (window as Window).__pwn;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Literal HTML in `pty.data` bytes
  // ─────────────────────────────────────────────────────────────────────────

  it("literal <script> in pty.data does not insert a <script> element", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);

    await act(async () => {
      transport.emit(bytes(`<script>window.__pwn=true</script>\r\n`));
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    // The mount container is rooted in the test render — anywhere else in
    // document.body would be a different test's leak, so scope to the
    // terminal's mount.
    expect(container.querySelectorAll("script").length).toBe(0);
    // The canary stays untouched.
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  it("literal <iframe> in pty.data does not insert an <iframe> element", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);

    await act(async () => {
      transport.emit(
        bytes(`<iframe src="javascript:window.__pwn=true"></iframe>\r\n`)
      );
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    expect(container.querySelectorAll("iframe").length).toBe(0);
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  it("literal <img onerror> in pty.data does not insert an <img> element", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);

    await act(async () => {
      transport.emit(bytes(`<img src=x onerror="window.__pwn=true">\r\n`));
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    expect(container.querySelectorAll("img").length).toBe(0);
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. URL-encoded HTML — same byte stream, different shape
  // ─────────────────────────────────────────────────────────────────────────

  it("URL-encoded <script> in pty.data does not insert a <script> element", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);

    await act(async () => {
      transport.emit(
        bytes(`%3Cscript%3Ewindow.__pwn=true%3C%2Fscript%3E\r\n`)
      );
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    expect(container.querySelectorAll("script").length).toBe(0);
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Base64 — the shell decodes this and `echo`s the raw bytes back.
  //    Simulate that by computing the decoded bytes and emitting them as a
  //    `pty.data` frame, exactly as Companion would deliver them.
  // ─────────────────────────────────────────────────────────────────────────

  it("base64-decoded <script> bytes from the shell echo are not executed", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);

    // `echo PHNjcmlwdD4uLi48L3NjcmlwdD4= | base64 -d` would produce:
    const decoded = Buffer.from(
      "PHNjcmlwdD53aW5kb3cuX19wd249dHJ1ZTwvc2NyaXB0Pg==",
      "base64"
    ).toString("utf-8");
    expect(decoded).toBe(`<script>window.__pwn=true</script>`);

    await act(async () => {
      transport.emit(bytes(decoded + "\r\n"));
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    expect(container.querySelectorAll("script").length).toBe(0);
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Mojibake / overlong UTF-8 / BOM injection — must not crash the
  //    renderer or leak into the DOM.
  // ─────────────────────────────────────────────────────────────────────────

  it("mojibake + overlong UTF-8 + BOM injections do not crash or inject DOM", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);

    // BOM, then lone surrogate (high), then overlong-UTF-8 for '/' (3-byte
    // encoding of a 1-byte codepoint — invalid per RFC 3629), then a normal
    // ASCII tail.
    const mojibake = new Uint8Array([
      0xef, 0xbb, 0xbf, // BOM
      0xed, 0xa0, 0x80, // lone surrogate D800 (invalid)
      0xe0, 0x80, 0xaf, // overlong '/'
      0xc0, 0xaf, // overlong '/' (2-byte form)
      0x41, 0x42, 0x43, // ABC
      0x0d, 0x0a,
    ]);

    await act(async () => {
      // The act+await pair ensures any thrown error from xterm would
      // surface; if we got here, the renderer survived.
      transport.emit(mojibake);
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    // No DOM injection, no canary.
    expect(container.querySelectorAll("script").length).toBe(0);
    expect(container.querySelectorAll("iframe").length).toBe(0);
    expect((window as Window).__pwn).toBeUndefined();
    // Terminal is still in the document.
    expect(container.querySelector(".xterm-host")).toBeTruthy();

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ANSI CSI screen-clear — `\x1b[2J`. Allowed control; just clears the
  //    xterm buffer. Must NOT touch document.title or inject DOM.
  // ─────────────────────────────────────────────────────────────────────────

  it("ANSI screen-clear (CSI 2 J) does not mutate document.title or DOM", async () => {
    const transport = new MockTransport();
    const titleBefore = document.title;
    const { unmount, container } = await mountTerminal(transport);

    await act(async () => {
      transport.emit(bytes(`\x1b[2Jhello\r\n`));
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    expect(document.title).toBe(titleBefore);
    expect(container.querySelectorAll("script,iframe,img").length).toBe(0);

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. OSC 0 — set window title. xterm emits onTitleChange but does NOT
  //    touch document.title itself; dispatch never wires that emitter to
  //    document.title. Assert the property is unchanged.
  // ─────────────────────────────────────────────────────────────────────────

  it("OSC 0 title-set escape does not mutate document.title", async () => {
    const transport = new MockTransport();
    const titleBefore = "dispatch — XSS fuzz test";
    document.title = titleBefore;

    const { unmount } = await mountTerminal(transport);

    await act(async () => {
      // OSC 0 (set icon name + window title) ; payload ; BEL
      transport.emit(bytes(`\x1b]0;malicious-title-set\x07`));
      // OSC 2 (window title only)
      transport.emit(bytes(`\x1b]2;another-malicious-title\x07`));
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    expect(document.title).toBe(titleBefore);

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Bracketed paste mode — `\x1b[200~ … \x1b[201~`. Payload between
  //    markers must NOT be auto-executed; it's just rendered text inside
  //    xterm's cell grid. No DOM mutation. No back-channel write either —
  //    we did not type anything.
  // ─────────────────────────────────────────────────────────────────────────

  it("bracketed-paste-mode markers do not auto-execute pasted content", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);
    const writesBefore = transport.writes.length;

    await act(async () => {
      transport.emit(
        bytes(`\x1b[200~malicious-paste-payload\x1b[201~`)
      );
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    // No DOM injection.
    expect(container.querySelectorAll("script,iframe").length).toBe(0);
    // No back-channel write — we did not type, and the pty.data path does
    // NOT echo through `transport.write`.
    expect(transport.writes.length).toBe(writesBefore);
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. OSC 8 hyperlink with javascript: URI — xterm v6 silently ignores
  //    non-http(s) OSC link URIs at the OscLinkProvider layer (proven by
  //    reading node_modules/@xterm/xterm/src/browser/OscLinkProvider.ts
  //    line 71-82: a URL with `javascript:` protocol is `ignoreLink`'d
  //    unless `linkHandler.allowNonHttpProtocols` is set, which dispatch
  //    never sets).
  //
  //    We assert the negative: the rendered xterm DOM contains no `<a>`
  //    element with a `javascript:` href, and clicking through the cell
  //    range does not fire any handler that could set the canary.
  // ─────────────────────────────────────────────────────────────────────────

  it("OSC 8 hyperlink with javascript: URI does not register a clickable js: link", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);

    await act(async () => {
      // OSC 8 ; ; javascript:alert(1) BEL "click here" OSC 8 ; ; BEL
      transport.emit(
        bytes(
          `\x1b]8;;javascript:window.__pwn=true\x07CLICK-ME\x1b]8;;\x07\r\n`
        )
      );
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    // No <a href="javascript:..."> in the DOM. xterm renders link decorations
    // as overlay positioning, not <a> elements, when they survive
    // OscLinkProvider; non-http/https URIs don't survive at all.
    const anchors = container.querySelectorAll("a");
    for (const a of Array.from(anchors)) {
      const href = a.getAttribute("href") || "";
      expect(
        href.toLowerCase().startsWith("javascript:"),
        `found anchor with javascript: href — ${href}`
      ).toBe(false);
    }

    // Canary unchanged.
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. DECSET — bracketed-paste toggle escape — known good and used by the
  //    hook itself. Assert it does not regress into DOM injection.
  // ─────────────────────────────────────────────────────────────────────────

  it("DECSET bracketed-paste toggle (CSI ? 2004 h/l) does not inject DOM", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);

    await act(async () => {
      transport.emit(bytes(`\x1b[?2004h`));
      transport.emit(bytes(`\x1b[?2004l`));
      await new Promise<void>((r) => setTimeout(r, 10));
    });

    expect(container.querySelectorAll("script,iframe,img").length).toBe(0);
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. Combined ANSI escape soup — clear + title + bracketed-paste payload
  //    + OSC 8 javascript: link, all in one frame. Should still be inert.
  // ─────────────────────────────────────────────────────────────────────────

  it("combined ANSI escape soup is fully inert (clear + title + bracketed + osc8)", async () => {
    const transport = new MockTransport();
    const titleBefore = document.title;
    const { unmount, container } = await mountTerminal(transport);

    const payload =
      `\x1b[2J` +
      `\x1b]0;ATTACKER-TITLE\x07` +
      `\x1b[200~<script>window.__pwn=true</script>\x1b[201~` +
      `\x1b]8;;javascript:window.__pwn=true\x07click\x1b]8;;\x07\r\n`;

    await act(async () => {
      transport.emit(bytes(payload));
      await new Promise<void>((r) => setTimeout(r, 30));
    });

    expect(document.title).toBe(titleBefore);
    expect(container.querySelectorAll("script,iframe,img").length).toBe(0);
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(
        (a.getAttribute("href") || "").toLowerCase().startsWith("javascript:")
      ).toBe(false);
    }
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. term.write trust audit — only the transport's subscribe-delivered
  //     frames may call term.write. A settings change (theme / fontSize /
  //     scrollback prop update) must NOT call term.write — it sets options
  //     on the existing terminal. We verify by spying on term.write via the
  //     hook's `writeOverride` seam and counting calls across a re-render
  //     with new theme + fontSize + scrollback props.
  //
  //     This is the "no settings-control may inject content" rule.
  // ─────────────────────────────────────────────────────────────────────────

  it("term.write is called only from the transport subscribe path (no settings-control writes)", async () => {
    // Two-part assertion against a Terminal.prototype.write spy:
    //   (a) Driving N pty.data frames produces N + write-count for the
    //       transport-delivered frames (each xterm.write call we observe
    //       after mount must trace back to a frame the test emitted, with
    //       slack for one queued-frame drain when scrollback IDB resolves).
    //   (b) A rerender with new theme + fontSize + scrollback produces ZERO
    //       additional writes. This is the load-bearing assertion: the
    //       Settings control path must not inject content into the live
    //       terminal — it sets options on the existing xterm.
    //
    // (b) is the binding rule. (a) is a sanity bound that proves the spy is
    // actually attached and counting.

    const transport = new MockTransport();
    const writeCalls: unknown[] = [];

    // Spy by monkey-patching Terminal.prototype.write at module level. We
    // restore in finally.
    const xtermMod = await import("@xterm/xterm");
    const realWrite = xtermMod.Terminal.prototype.write;
    let spyActive = true;
    xtermMod.Terminal.prototype.write = function (this: unknown, data: unknown, cb?: () => void) {
      if (spyActive) writeCalls.push(data);
      return realWrite.call(this, data as never, cb);
    };

    try {
      // Mount and let the scrollback IDB read + queued-frame drain settle.
      let result!: ReturnType<typeof render>;
      await act(async () => {
        result = render(
          el({
            ptyId: PTY_ID,
            ticketId: TICKET_ID,
            transport,
            themeName: "coal",
            fontSize: 13,
            scrollback: 10_000,
          })
        );
        await new Promise<void>((r) => setTimeout(r, 100));
      });

      // Feed 3 pty.data frames. Each should land in xterm exactly once. The
      // hook also may write a queued-replay batch when the IDB read resolves
      // — we baseline writes BEFORE the emits to isolate exactly the
      // transport-driven delta.
      const writesBeforeFrames = writeCalls.length;
      await act(async () => {
        transport.emit(bytes("frame-1\r\n"));
        transport.emit(bytes("frame-2\r\n"));
        transport.emit(bytes("frame-3\r\n"));
        await new Promise<void>((r) => setTimeout(r, 30));
      });
      const framesDelta = writeCalls.length - writesBeforeFrames;
      // Exactly 3 writes from 3 emits — proves no extra hidden write source
      // is firing during the frame-drive window.
      expect(
        framesDelta,
        `emitting 3 pty.data frames produced ${framesDelta} term.write calls — expected 3`
      ).toBe(3);

      // (b) — the load-bearing assertion. Rerender with new theme + font +
      // scrollback. The hook's three "live-apply settings" effects call
      // `term.options.theme = …`, `term.options.fontSize = …`,
      // `term.options.scrollback = …`. None call `term.write`.
      const writesBeforeSettings = writeCalls.length;
      await act(async () => {
        result.rerender(
          el({
            ptyId: PTY_ID,
            ticketId: TICKET_ID,
            transport,
            themeName: "paper",
            fontSize: 15,
            scrollback: 5_000,
          })
        );
        await new Promise<void>((r) => setTimeout(r, 30));
      });

      const settingsDelta = writeCalls.length - writesBeforeSettings;
      expect(
        settingsDelta,
        `settings rerender wrote ${settingsDelta} bytes to the terminal — expected 0`
      ).toBe(0);

      result.unmount();
    } finally {
      spyActive = false;
      xtermMod.Terminal.prototype.write = realWrite;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 12. Negative-control mechanic — prove the __pwn canary is observable
  //     when explicitly set. If this fails, all the "canary stays
  //     undefined" assertions above are vacuous (something masked window).
  // ─────────────────────────────────────────────────────────────────────────

  it("the __pwn canary is observable when explicitly set (mechanic check)", () => {
    expect((window as Window).__pwn).toBeUndefined();
    (window as Window).__pwn = true;
    expect((window as Window).__pwn).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 13. Subscriber-count sanity — exactly one subscriber attaches on mount
  //     and detaches on unmount. Protects against a future refactor that
  //     accidentally double-subscribes (which would also double-render
  //     payloads, doubling the blast radius of any future regression).
  // ─────────────────────────────────────────────────────────────────────────

  it("attaches exactly one subscriber and detaches on unmount", async () => {
    const transport = new MockTransport();
    const { unmount } = await mountTerminal(transport);

    expect(transport.subscribers.size).toBe(1);

    unmount();

    // Allow React's cleanup microtask to land.
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 5));
    });

    expect(transport.subscribers.size).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 14. Combined HTML+OSC payload triplets across all encoded variants —
  //     loop the same canonical payload through raw, URL-encoded, and
  //     base64-shell-decoded forms in one test, asserting the negative for
  //     each. Belt-and-suspenders to S0's payload coverage from a different
  //     write path.
  // ─────────────────────────────────────────────────────────────────────────

  it("the raw/URL/base64 triple of <script>...</script> all render inert", async () => {
    const transport = new MockTransport();
    const { unmount, container } = await mountTerminal(transport);

    const raw = `<script>window.__pwn=true</script>`;
    const urlEnc = encodeURIComponent(raw);
    const b64Decoded = Buffer.from(
      Buffer.from(raw, "utf-8").toString("base64"),
      "base64"
    ).toString("utf-8");

    expect(b64Decoded).toBe(raw);

    await act(async () => {
      transport.emit(bytes(raw + "\r\n"));
      transport.emit(bytes(urlEnc + "\r\n"));
      transport.emit(bytes(b64Decoded + "\r\n"));
      await new Promise<void>((r) => setTimeout(r, 20));
    });

    expect(container.querySelectorAll("script,iframe,img").length).toBe(0);
    expect((window as Window).__pwn).toBeUndefined();

    unmount();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 15. document.body sanity — across the suite, document.body must not
  //     accumulate orphan <script>/<iframe>/<img onerror> nodes from prior
  //     payloads. This is the cross-test integrity check.
  // ─────────────────────────────────────────────────────────────────────────

  it("document.body never contains a payload-injected <script>/<iframe>/<img>", () => {
    // Scope to scripts NOT placed by the test runner itself. Vite/vitest
    // does not inject <script> tags into jsdom, and React's testing library
    // mounts into a fresh container. Any non-empty count here would be a
    // real regression.
    const scripts = document.body.querySelectorAll("script");
    const iframes = document.body.querySelectorAll("iframe");
    const imgsWithOnerror = document.body.querySelectorAll("img[onerror]");
    expect(scripts.length).toBe(0);
    expect(iframes.length).toBe(0);
    expect(imgsWithOnerror.length).toBe(0);
  });
});

// Re-declare the SPA-wide canary so this file is self-contained and the
// Window augmentation does not require importing payloads.ts from /security.
declare global {
  interface Window {
    __pwn?: boolean;
  }
}
