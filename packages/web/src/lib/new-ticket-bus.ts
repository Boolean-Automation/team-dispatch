// dispatch — new-ticket open bus (web-only, no core dependency)
//
// Mirrors the toast event bus in use-undoable-mutation.ts. The create-ticket
// UI lives once in the Topbar; other surfaces (e.g. the per-column "+" button)
// call openNewTicket() to pop it open without prop-drilling a handler through
// the board tree.

type OpenNewTicketHandler = () => void;

let _handler: OpenNewTicketHandler | null = null;

export function registerNewTicketHandler(handler: OpenNewTicketHandler): void {
  _handler = handler;
}

export function unregisterNewTicketHandler(
  handler: OpenNewTicketHandler
): void {
  if (_handler === handler) _handler = null;
}

/** Open the hand-create ticket UI. No-op when no handler is mounted. */
export function openNewTicket(): void {
  _handler?.();
}
