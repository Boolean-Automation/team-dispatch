// dispatch — LauncherConsentModal tests (Phase 2 / Slice 4).
//
// Tests (binding from the slice plan):
//   1. Renders when prop says first-edit (open=true).
//   2. Does NOT render when open=false.
//   3. Cancel button fires onCancel.
//   4. Confirm fires onConfirm with a launcherConsentedAt ISO timestamp.
//   5. Escape key fires onCancel.
//   6. Focus trap keeps focus inside the modal (Tab from confirm → cancel).
//   7. shouldFireConsentModal logic: claude (no), non-default w/o consent (yes),
//      non-default w/ recent consent (no), non-default w/ >12mo consent (yes).

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import {
  LauncherConsentModal,
  shouldFireConsentModal,
} from "./launcher-consent-modal.js";

afterEach(() => {
  cleanup();
});

describe("LauncherConsentModal — rendering", () => {
  it("renders the modal when open=true", () => {
    render(
      <LauncherConsentModal
        open={true}
        pendingCommand="codex"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByTestId("launcher-consent-modal")).toBeTruthy();
    expect(
      screen.getByText(
        /This button types the command into your real local shell/i
      )
    ).toBeTruthy();
  });

  it("renders nothing when open=false", () => {
    render(
      <LauncherConsentModal
        open={false}
        pendingCommand="codex"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.queryByTestId("launcher-consent-modal")).toBeNull();
  });
});

describe("LauncherConsentModal — interaction", () => {
  it("Cancel button fires onCancel", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <LauncherConsentModal
        open={true}
        pendingCommand="codex"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByTestId("launcher-consent-cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Confirm fires onConfirm with the ISO consentedAt timestamp", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const frozenNow = new Date("2026-05-22T10:30:00.000Z");
    render(
      <LauncherConsentModal
        open={true}
        pendingCommand="codex"
        onConfirm={onConfirm}
        onCancel={onCancel}
        now={() => frozenNow}
      />
    );

    fireEvent.click(screen.getByTestId("launcher-consent-confirm"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0]).toEqual({
      launcherConsentedAt: "2026-05-22T10:30:00.000Z",
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape key fires onCancel", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <LauncherConsentModal
        open={true}
        pendingCommand="codex"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("focus-trap keeps focus inside the modal (Tab from confirm → cancel)", async () => {
    render(
      <LauncherConsentModal
        open={true}
        pendingCommand="codex"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    const cancel = screen.getByTestId(
      "launcher-consent-cancel"
    ) as HTMLButtonElement;
    const confirm = screen.getByTestId(
      "launcher-consent-confirm"
    ) as HTMLButtonElement;
    const modal = screen.getByTestId(
      "launcher-consent-modal"
    ) as HTMLDivElement;

    // Wait one tick for the auto-focus effect to run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });

    // Focus starts on the cancel button (the safer default).
    expect(document.activeElement).toBe(cancel);

    // Move focus to confirm — simulate Tab.
    confirm.focus();
    expect(document.activeElement).toBe(confirm);

    // Tab from confirm → wraps back to cancel.
    fireEvent.keyDown(modal, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);

    // Shift+Tab from cancel → wraps to confirm.
    fireEvent.keyDown(modal, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("clicking the backdrop fires onCancel", () => {
    const onCancel = vi.fn();
    render(
      <LauncherConsentModal
        open={true}
        pendingCommand="codex"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    const backdrop = screen.getByTestId("launcher-consent-backdrop");
    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("shouldFireConsentModal", () => {
  it("returns false when the pending command is the default 'claude'", () => {
    expect(
      shouldFireConsentModal({
        pendingCommand: "claude",
        previousConsentedAt: null,
      })
    ).toBe(false);
  });

  it("returns true when the pending command is non-default and no prior consent exists", () => {
    expect(
      shouldFireConsentModal({
        pendingCommand: "codex",
        previousConsentedAt: null,
      })
    ).toBe(true);
  });

  it("returns false when there is a recent (< 12mo) prior consent", () => {
    expect(
      shouldFireConsentModal({
        pendingCommand: "codex",
        previousConsentedAt: "2026-01-15T00:00:00.000Z",
        now: new Date("2026-05-22T00:00:00.000Z"),
      })
    ).toBe(false);
  });

  it("returns true when the prior consent is older than 12 months", () => {
    expect(
      shouldFireConsentModal({
        pendingCommand: "codex",
        previousConsentedAt: "2025-01-01T00:00:00.000Z",
        now: new Date("2026-05-22T00:00:00.000Z"),
      })
    ).toBe(true);
  });

  it("returns true when the prior consent string is malformed", () => {
    expect(
      shouldFireConsentModal({
        pendingCommand: "codex",
        previousConsentedAt: "not-an-iso-date",
      })
    ).toBe(true);
  });
});
