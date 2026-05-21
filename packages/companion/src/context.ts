/**
 * dispatch Companion — context injection (OQ-S2).
 *
 * The Companion opens `claude` with its cwd at the boolean-knowledge repo root
 * (proven by the prototype — Test C). On top of that ambient file context, the
 * per-Ticket payload is delivered as the session's FIRST `pty.write()` — an
 * opening preamble typed into the interactive session. This needs no `claude`
 * flag support, works against the installed CLI as-is, and is visible in the
 * rendered panel (good for the A15 L1 recording).
 *
 * The minimum payload (pre-brief §53): client slug, Ticket id (DSP-####),
 * Ticket title, status, the thread up to the cursor.
 */

/** The Ticket + Account context the panel hands the Companion at connect. */
export interface TicketContext {
  /** Client slug, e.g. "prorise". */
  clientSlug: string;
  /** Display id, DSP-#### form. */
  displayId: string;
  /** Ticket title. */
  title: string;
  /** Ticket status, e.g. "in_progress". */
  status: string;
  /** The Slack/chat thread up to the SE's cursor (most-recent-last). */
  threadToCursor?: string;
}

/**
 * Build the compact context preamble the bridge `pty.write()`s as the session's
 * first input. The preamble is a plain-text message — it reads naturally in the
 * xterm.js panel and gives `claude` the Ticket the SE is working.
 *
 * The returned string ends with a newline so the PTY submits it as one turn.
 */
export function buildContextPreamble(ctx: TicketContext): string {
  const lines: string[] = [];
  lines.push(
    `I am a Boolean support engineer working dispatch ticket ${ctx.displayId}.`
  );
  lines.push(`Client: ${ctx.clientSlug}. Title: ${ctx.title}. Status: ${ctx.status}.`);
  lines.push(
    `My working directory is the boolean-knowledge repo root — you have the ` +
      `whole knowledge base as file context.`
  );
  if (ctx.threadToCursor && ctx.threadToCursor.trim().length > 0) {
    lines.push("");
    lines.push("Thread so far (most recent last):");
    lines.push(ctx.threadToCursor.trim());
  }
  lines.push("");
  lines.push(
    "Acknowledge the ticket context briefly, then wait for my question."
  );
  return lines.join("\n") + "\n";
}
