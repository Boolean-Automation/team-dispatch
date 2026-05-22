// dispatch — find overlay (Phase 2 / Slice 3).
//
// VS-Code-style search overlay anchored top-right inside `.term-stage`. The
// overlay wires the xterm SearchAddon's findNext / findPrevious:
//   - Enter         → next
//   - Shift+Enter   → prev
//   - Escape        → close
//   - Cmd/Ctrl+F    → toggle (handled by the parent panel; the overlay just
//                     mounts/unmounts via a prop)
//
// Visual spec §3.3 + §5.4. The overlay is keyboard-first and consumes its own
// keydown events so xterm doesn't receive them while focus is in the input.

import React, { useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import Ic from "../shell/Ic.js";

export interface FindOverlayProps {
  /** The SearchAddon driven by this overlay (from Terminal handle). */
  searchAddon: SearchAddon | null;
  /** Close the overlay (Escape, close button, parent unmount). */
  onClose: () => void;
}

export function FindOverlay({
  searchAddon,
  onClose,
}: FindOverlayProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-focus the input on mount so the SE can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function runNext() {
    if (!query) return;
    try {
      searchAddon?.findNext(query);
    } catch {
      /* addon not yet loaded */
    }
  }

  function runPrev() {
    if (!query) return;
    try {
      searchAddon?.findPrevious(query);
    } catch {
      /* addon not yet loaded */
    }
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLInputElement>) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      runNext();
    } else if (ev.key === "Enter" && ev.shiftKey) {
      ev.preventDefault();
      runPrev();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    }
  }

  return (
    <div className="term-find" role="search">
      <input
        ref={inputRef}
        type="text"
        placeholder="Find"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Find in terminal"
      />
      <button
        type="button"
        className="fbtn"
        onClick={runPrev}
        title="Previous (Shift+Enter)"
        aria-label="Previous match"
      >
        <Ic.chevUp />
      </button>
      <button
        type="button"
        className="fbtn"
        onClick={runNext}
        title="Next (Enter)"
        aria-label="Next match"
      >
        <Ic.chev />
      </button>
      <button
        type="button"
        className="fbtn"
        onClick={onClose}
        title="Close (Escape)"
        aria-label="Close find"
      >
        ×
      </button>
    </div>
  );
}
