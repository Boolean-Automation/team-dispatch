// dispatch — key-handler tests (Phase 2 / Slice 2).
//
// Exercises the selection-aware Cmd/Ctrl+C/V keyboard discipline through its
// public interface only (`installKeyHandler(term, transport, ptyId)`).
//
// The xterm `Terminal` is mocked with the minimal shape the handler reads
// (`getSelection`, `attachCustomKeyEventHandler`). The transport is the
// minimal `TerminalWriteTransport` contract — `write(ptyId, text)`.

import { describe, expect, beforeEach, vi, it } from "vitest";
import { installKeyHandler } from "./key-handler.js";

interface MockClipboard {
  readText: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
}

interface MockTerm {
  getSelection: ReturnType<typeof vi.fn>;
  attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
  /** The handler installed via attachCustomKeyEventHandler. */
  _handler: ((ev: KeyboardEvent) => boolean) | null;
}

function makeMockTerm(): MockTerm {
  const term: MockTerm = {
    getSelection: vi.fn(() => ""),
    attachCustomKeyEventHandler: vi.fn(),
    _handler: null,
  };
  term.attachCustomKeyEventHandler.mockImplementation(
    (fn: (ev: KeyboardEvent) => boolean) => {
      term._handler = fn;
    }
  );
  return term;
}

function makeMockClipboard(): MockClipboard {
  return {
    readText: vi.fn(async () => ""),
    writeText: vi.fn(async () => undefined),
  };
}

function kbd(
  key: string,
  modifiers: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {}
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    code: `Key${key.toUpperCase()}`,
    metaKey: !!modifiers.meta,
    ctrlKey: !!modifiers.ctrl,
    shiftKey: !!modifiers.shift,
  });
}

describe("installKeyHandler", () => {
  let term: MockTerm;
  let clipboard: MockClipboard;
  let writeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    term = makeMockTerm();
    clipboard = makeMockClipboard();
    writeSpy = vi.fn();
  });

  it("Cmd+C with a selection copies via clipboard, swallows the event, does NOT send SIGINT", async () => {
    term.getSelection.mockReturnValue("selected text");

    installKeyHandler(
      term as unknown as Parameters<typeof installKeyHandler>[0],
      { write: writeSpy },
      "pty-1",
      { clipboard: clipboard as unknown as Clipboard }
    );

    const ev = kbd("c", { meta: true });
    const consumed = term._handler?.(ev);

    // The handler must swallow the event (return false to tell xterm not to
    // process it).
    expect(consumed).toBe(false);

    // Wait for the clipboard write microtask.
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboard.writeText).toHaveBeenCalledWith("selected text");
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("Cmd+C with NO selection sends SIGINT (\\x03) through the transport", () => {
    term.getSelection.mockReturnValue("");

    installKeyHandler(
      term as unknown as Parameters<typeof installKeyHandler>[0],
      { write: writeSpy },
      "pty-1",
      { clipboard: clipboard as unknown as Clipboard }
    );

    const ev = kbd("c", { meta: true });
    const consumed = term._handler?.(ev);

    expect(consumed).toBe(false);
    expect(writeSpy).toHaveBeenCalledWith("pty-1", "\x03");
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("Ctrl+C with a selection copies (Linux/Windows discipline parity)", async () => {
    term.getSelection.mockReturnValue("selected");

    installKeyHandler(
      term as unknown as Parameters<typeof installKeyHandler>[0],
      { write: writeSpy },
      "pty-1",
      { clipboard: clipboard as unknown as Clipboard }
    );

    const ev = kbd("c", { ctrl: true });
    const consumed = term._handler?.(ev);

    expect(consumed).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(clipboard.writeText).toHaveBeenCalledWith("selected");
  });

  it("Cmd+V reads clipboard and writes the bytes through the transport", async () => {
    clipboard.readText.mockResolvedValue("pasted-content");

    installKeyHandler(
      term as unknown as Parameters<typeof installKeyHandler>[0],
      { write: writeSpy },
      "pty-1",
      { clipboard: clipboard as unknown as Clipboard }
    );

    const ev = kbd("v", { meta: true });
    const consumed = term._handler?.(ev);

    expect(consumed).toBe(false);
    // Flush the async clipboard.readText → transport.write chain.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(clipboard.readText).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith("pty-1", "pasted-content");
  });

  it("ignores non-C/V Cmd/Ctrl chords (lets xterm handle them)", () => {
    installKeyHandler(
      term as unknown as Parameters<typeof installKeyHandler>[0],
      { write: writeSpy },
      "pty-1",
      { clipboard: clipboard as unknown as Clipboard }
    );

    const ev = kbd("a", { meta: true });
    const consumed = term._handler?.(ev);

    // True = "xterm, this event is yours to process."
    expect(consumed).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("ignores Cmd+Shift+C (a common 'open inspector' chord) — leaves it for the browser", () => {
    installKeyHandler(
      term as unknown as Parameters<typeof installKeyHandler>[0],
      { write: writeSpy },
      "pty-1",
      { clipboard: clipboard as unknown as Clipboard }
    );

    const ev = kbd("c", { meta: true, shift: true });
    const consumed = term._handler?.(ev);

    // We only want plain Cmd/Ctrl + C/V; Shift mod = let xterm/browser handle.
    expect(consumed).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("dispose() reattaches a noop handler so subsequent chords no longer fire", () => {
    term.getSelection.mockReturnValue("");

    const dispose = installKeyHandler(
      term as unknown as Parameters<typeof installKeyHandler>[0],
      { write: writeSpy },
      "pty-1",
      { clipboard: clipboard as unknown as Clipboard }
    );

    dispose();

    const ev = kbd("c", { meta: true });
    term._handler?.(ev);

    // The disposed handler must NOT fire SIGINT — the noop just returns true
    // (lets xterm handle anything).
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
