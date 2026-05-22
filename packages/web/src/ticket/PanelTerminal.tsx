// dispatch — PanelTerminal: RETIRED in Phase 2 / Slice 3.
//
// The Spike #1 right-panel terminal mode has been retired (visual spec §0,
// §11.3; plan §S3 OQ-4). The terminal surface moves to `TerminalPanel` —
// bottom-slide-up by default, dock-right via Settings (S5).
//
// This file is kept as an explicit shim so anything that still imports it
// fails loudly rather than silently rendering a dead component. The
// `.term-fail` failure-block JSX was salvaged into `TerminalPanel`'s
// `<TermFailure>` render branch.
//
// Use `import { TerminalPanel } from "../terminal/TerminalPanel.js";` instead.

import React from "react";
import type { Ticket } from "../lib/types";
import type { TerminalTransport } from "./terminal-transport.js";

export interface PanelTerminalProps {
  ticket: Ticket;
  clientSlug?: string;
  transport?: TerminalTransport;
}

/**
 * @deprecated Retired in Phase 2 / Slice 3. Use `TerminalPanel` from
 * `../terminal/TerminalPanel.js`. The Spike #1 right-panel mode is gone;
 * the panel now lives at the bottom of the ticket route (default) or docked
 * to the right edge per the SE's Settings preference.
 */
export function PanelTerminal(_props: PanelTerminalProps): React.ReactElement {
  throw new Error(
    "PanelTerminal is retired in Phase 2. Use TerminalPanel from `../terminal/TerminalPanel`."
  );
}
