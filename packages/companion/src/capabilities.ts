/**
 * dispatch Companion — capability negotiation (Phase 2).
 *
 * Each side of the handshake advertises a list of capability strings; the
 * intersection drives feature activation. New feature = new string. An older
 * peer that doesn't advertise a capability silently degrades on that feature,
 * with no hard `PROTOCOL_VERSION` mismatch (which still fires for breaking
 * frame-shape changes).
 */

export const COMPANION_CAPABILITIES: readonly string[] = [
  "multi-pty",
  "scrollback-restore",
  "unicode11",
  "ligatures",
  "webgl-renderer",
];

/**
 * Compute the intersection of two capability arrays. Order-preserving with
 * respect to `a`; dedupes (a capability listed twice on either side counts
 * once).
 */
export function intersect(a: readonly string[], b: readonly string[]): string[] {
  const setB = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cap of a) {
    if (setB.has(cap) && !seen.has(cap)) {
      out.push(cap);
      seen.add(cap);
    }
  }
  return out;
}
