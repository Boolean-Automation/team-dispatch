// dispatch — status-ladder tests
//
// Tests:
//   1. validateTransition — allowed transitions pass.
//   2. validateTransition — disallowed transitions fail.
//   3. validateTransition — same-status transition fails.
//   4. resolveReplyTransition — on-you → waiting-client (A15).
//   5. resolveReplyTransition — follow-up-required → follow-up-1-sent (FIX 4).
//   6. resolveReplyTransition — other statuses return null (no transition).
//   7. resolveClientReplyTransition — waiting-client → on-you (A16).
//   8. resolveClientReplyTransition — closed → on-you (A17 reopen).
//   9. resolveClientReplyTransition — other statuses return null.
//  10. resolveTimer2bdTransition — waiting-client → follow-up-required.
//  11. resolveTimer3bdTransition — follow-up-1-sent → closeout.
//  12. complete is allowed from all non-terminal states.
//  13. complete has no outbound transitions (terminal).

import { describe, it, expect } from "vitest";
import {
  validateTransition,
  resolveReplyTransition,
  resolveClientReplyTransition,
  resolveTimer2bdTransition,
  resolveTimer3bdTransition,
} from "../src/services/status-ladder.js";
import type { TicketStatus } from "../src/entities/ticket.js";

describe("validateTransition — allowed transitions", () => {
  it("new → on-you (routing)", () => {
    const r = validateTransition("new", "on-you");
    expect(r.ok).toBe(true);
    expect(r.toStatus).toBe("on-you");
  });

  it("on-you → waiting-client (A15 SE reply)", () => {
    const r = validateTransition("on-you", "waiting-client");
    expect(r.ok).toBe(true);
  });

  it("waiting-client → on-you (A16 client reply)", () => {
    expect(validateTransition("waiting-client", "on-you").ok).toBe(true);
  });

  it("waiting-client → follow-up-required (A18 timer)", () => {
    expect(validateTransition("waiting-client", "follow-up-required").ok).toBe(true);
  });

  it("follow-up-required → follow-up-1-sent (FIX 4 SE first follow-up)", () => {
    expect(validateTransition("follow-up-required", "follow-up-1-sent").ok).toBe(true);
  });

  it("follow-up-1-sent → closeout (A18 3bd timer)", () => {
    expect(validateTransition("follow-up-1-sent", "closeout").ok).toBe(true);
  });

  it("closeout → closed (manual)", () => {
    expect(validateTransition("closeout", "closed").ok).toBe(true);
  });

  it("closed → on-you (A17 reopen)", () => {
    expect(validateTransition("closed", "on-you").ok).toBe(true);
  });

  it("on-you → complete (A19 manual promotion)", () => {
    expect(validateTransition("on-you", "complete").ok).toBe(true);
  });

  it("waiting-client → complete (A19 manual)", () => {
    expect(validateTransition("waiting-client", "complete").ok).toBe(true);
  });

  it("follow-up-required → complete (A19 manual)", () => {
    expect(validateTransition("follow-up-required", "complete").ok).toBe(true);
  });

  it("closed → complete (A19 manual)", () => {
    expect(validateTransition("closed", "complete").ok).toBe(true);
  });
});

describe("validateTransition — disallowed transitions", () => {
  it("new → closed is not allowed", () => {
    const r = validateTransition("new", "closed");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not allowed/i);
  });

  it("on-you → follow-up-required is not allowed (must pass through waiting-client)", () => {
    expect(validateTransition("on-you", "follow-up-required").ok).toBe(false);
  });

  it("waiting-client → closed is not allowed directly", () => {
    expect(validateTransition("waiting-client", "closed").ok).toBe(false);
  });

  it("follow-up-required → waiting-client is not allowed (wrong direction)", () => {
    expect(validateTransition("follow-up-required", "waiting-client").ok).toBe(false);
  });

  it("complete → on-you is not allowed (terminal state)", () => {
    const r = validateTransition("complete", "on-you");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/none/i);
  });

  it("follow-up-1-sent → follow-up-required is not allowed (backwards)", () => {
    expect(validateTransition("follow-up-1-sent", "follow-up-required").ok).toBe(false);
  });
});

describe("validateTransition — same-status", () => {
  it("on-you → on-you fails with 'already in status' error", () => {
    const r = validateTransition("on-you", "on-you");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already/i);
  });
});

describe("resolveReplyTransition", () => {
  it("on-you → waiting-client (A15: SE sends reply)", () => {
    expect(resolveReplyTransition("on-you")).toBe("waiting-client");
  });

  it("follow-up-required → follow-up-1-sent (FIX 4: SE sends first follow-up)", () => {
    expect(resolveReplyTransition("follow-up-required")).toBe("follow-up-1-sent");
  });

  it("waiting-client returns null (no transition from waiting-client)", () => {
    expect(resolveReplyTransition("waiting-client")).toBeNull();
  });

  it("new returns null", () => {
    expect(resolveReplyTransition("new")).toBeNull();
  });

  it("closed returns null — reply never transitions closed", () => {
    expect(resolveReplyTransition("closed")).toBeNull();
  });

  it("complete returns null", () => {
    expect(resolveReplyTransition("complete")).toBeNull();
  });

  it("follow-up-1-sent returns null", () => {
    expect(resolveReplyTransition("follow-up-1-sent")).toBeNull();
  });

  it("closeout returns null", () => {
    expect(resolveReplyTransition("closeout")).toBeNull();
  });
});

describe("resolveClientReplyTransition", () => {
  it("waiting-client → on-you (A16: client replied while SE was waiting)", () => {
    expect(resolveClientReplyTransition("waiting-client")).toBe("on-you");
  });

  it("closed → on-you (A17: client reply reopens a closed ticket)", () => {
    expect(resolveClientReplyTransition("closed")).toBe("on-you");
  });

  it("on-you returns null (client reply on on-you doesn't change status)", () => {
    expect(resolveClientReplyTransition("on-you")).toBeNull();
  });

  it("follow-up-required returns null", () => {
    expect(resolveClientReplyTransition("follow-up-required")).toBeNull();
  });

  it("follow-up-1-sent returns null", () => {
    expect(resolveClientReplyTransition("follow-up-1-sent")).toBeNull();
  });

  it("new returns null", () => {
    expect(resolveClientReplyTransition("new")).toBeNull();
  });

  it("complete returns null", () => {
    expect(resolveClientReplyTransition("complete")).toBeNull();
  });
});

describe("resolveTimer2bdTransition", () => {
  it("waiting-client → follow-up-required (A18 first advance)", () => {
    expect(resolveTimer2bdTransition("waiting-client")).toBe("follow-up-required");
  });

  it("follow-up-required returns null — timer never advances follow-up-required (waits for SE)", () => {
    expect(resolveTimer2bdTransition("follow-up-required")).toBeNull();
  });

  it("follow-up-1-sent returns null — different timer", () => {
    expect(resolveTimer2bdTransition("follow-up-1-sent")).toBeNull();
  });

  it("on-you returns null", () => {
    expect(resolveTimer2bdTransition("on-you")).toBeNull();
  });
});

describe("resolveTimer3bdTransition", () => {
  it("follow-up-1-sent → closeout (A18 second advance after 3bd from followUp1SentAt)", () => {
    expect(resolveTimer3bdTransition("follow-up-1-sent")).toBe("closeout");
  });

  it("waiting-client returns null — different timer", () => {
    expect(resolveTimer3bdTransition("waiting-client")).toBeNull();
  });

  it("follow-up-required returns null — timer never advances follow-up-required", () => {
    expect(resolveTimer3bdTransition("follow-up-required")).toBeNull();
  });

  it("closeout returns null", () => {
    expect(resolveTimer3bdTransition("closeout")).toBeNull();
  });
});

describe("full 7-state ladder chain", () => {
  it("the full canonical ladder path is valid step by step", () => {
    const ladder: TicketStatus[] = [
      "new",
      "on-you",
      "waiting-client",
      "follow-up-required",
      "follow-up-1-sent",
      "closeout",
      "closed",
    ];

    for (let i = 0; i < ladder.length - 1; i++) {
      const from = ladder[i]!;
      const to = ladder[i + 1]!;
      const r = validateTransition(from, to);
      expect(r.ok, `Expected ${from} → ${to} to be allowed`).toBe(true);
    }
  });

  it("complete is reachable from every state except complete itself", () => {
    const allStatuses: TicketStatus[] = [
      "new",
      "on-you",
      "waiting-client",
      "follow-up-required",
      "follow-up-1-sent",
      "closeout",
      "closed",
    ];
    for (const s of allStatuses) {
      const r = validateTransition(s, "complete");
      expect(r.ok, `Expected ${s} → complete to be allowed`).toBe(true);
    }
  });
});
