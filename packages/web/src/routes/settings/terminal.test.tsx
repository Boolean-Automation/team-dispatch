// dispatch — Settings → Terminal page tests (Phase 2 / Slice 5).
//
// Per the slice plan:
//   1. Page renders all 5 controls with defaults.
//   2. Control change fires save() against the (mock) Clerk user.
//   3. Theme change emits a BroadcastChannel event for opener/popout sync.
//   4. Non-default launcher save fires the consent modal.
//   5. Consent cancel does NOT write Clerk.
//   6. Consent confirm writes BOTH launcher and launcherConsentedAt.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TerminalSettingsPage } from "./terminal.js";
import type { ClerkLikeUser } from "../../settings/use-terminal-settings.js";

function makeFakeUser(initial?: Record<string, unknown>): ClerkLikeUser & {
  writes: Array<Record<string, unknown>>;
} {
  let pm: Record<string, unknown> = { ...(initial ?? {}) };
  const writes: Array<Record<string, unknown>> = [];
  return {
    id: "user_terminal_page",
    get publicMetadata() {
      return pm;
    },
    async reload() {
      /* no-op — pm mutated in update() */
    },
    async update(patch: { publicMetadata: Record<string, unknown> }) {
      pm = { ...patch.publicMetadata };
      writes.push(patch.publicMetadata);
    },
    writes,
  };
}

function renderPage(user: ClerkLikeUser | null) {
  return render(
    <MemoryRouter initialEntries={["/settings/terminal"]}>
      <TerminalSettingsPage userOverride={user} />
    </MemoryRouter>
  );
}

describe("TerminalSettingsPage — visual spec §6.3 contract", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders all 5 controls with default values when metadata is absent", () => {
    const user = makeFakeUser({});
    renderPage(user);

    // 1. Panel position — default Bottom.
    expect(
      screen.getByTestId("seg-position-bottom").getAttribute("aria-checked")
    ).toBe("true");
    expect(
      screen.getByTestId("seg-position-right").getAttribute("aria-checked")
    ).toBe("false");

    // 2. Launcher — default Claude/claude.
    expect(
      (screen.getByTestId("launcher-label-input") as HTMLInputElement).value
    ).toBe("Claude");
    expect(
      (screen.getByTestId("launcher-command-input") as HTMLInputElement).value
    ).toBe("claude");

    // 3. Theme — default Coal.
    expect(
      screen.getByTestId("seg-theme-coal").getAttribute("aria-checked")
    ).toBe("true");

    // 4. Font — default JetBrains Mono / size 13.
    expect(
      (screen.getByTestId("font-family-select") as HTMLSelectElement).value
    ).toBe("JetBrains Mono");
    expect(
      screen.getByTestId("seg-font-size-13").getAttribute("aria-checked")
    ).toBe("true");

    // 5. Scrollback — default 10k.
    expect(
      screen.getByTestId("seg-scrollback-10000").getAttribute("aria-checked")
    ).toBe("true");
  });

  it("changing theme fires a save through to Clerk publicMetadata", async () => {
    const user = makeFakeUser({
      terminalSettings: {
        _v: 1,
        position: "bottom",
        theme: "coal",
        font: { family: "JetBrains Mono", size: 13 },
        scrollbackLines: 10000,
        launcher: { label: "Claude", command: "claude" },
        launcherConsentedAt: null,
      },
    });
    renderPage(user);

    await act(async () => {
      fireEvent.click(screen.getByTestId("seg-theme-paper"));
      // Debounce is 500ms by default — wait it out.
      await new Promise((r) => setTimeout(r, 600));
    });

    expect(user.writes.length).toBeGreaterThanOrEqual(1);
    const last = user.writes[user.writes.length - 1]!;
    const ts = last["terminalSettings"] as { theme: string; _v: number };
    expect(ts.theme).toBe("paper");
    expect(ts._v).toBe(1);
  });

  it("changing position fires a save through to Clerk publicMetadata", async () => {
    const user = makeFakeUser({});
    renderPage(user);

    await act(async () => {
      fireEvent.click(screen.getByTestId("seg-position-right"));
      await new Promise((r) => setTimeout(r, 600));
    });

    const last = user.writes[user.writes.length - 1]!;
    const ts = last["terminalSettings"] as { position: string };
    expect(ts.position).toBe("right");
  });

  it("changing font size fires a save preserving font.family", async () => {
    const user = makeFakeUser({
      terminalSettings: {
        _v: 1,
        position: "bottom",
        theme: "coal",
        font: { family: "JetBrains Mono", size: 13 },
        scrollbackLines: 10000,
        launcher: { label: "Claude", command: "claude" },
        launcherConsentedAt: null,
      },
    });
    renderPage(user);

    await act(async () => {
      fireEvent.click(screen.getByTestId("seg-font-size-14"));
      await new Promise((r) => setTimeout(r, 600));
    });

    const last = user.writes[user.writes.length - 1]!;
    const font = (last["terminalSettings"] as { font: { family: string; size: number } }).font;
    expect(font.size).toBe(14);
    expect(font.family).toBe("JetBrains Mono"); // preserved
  });

  it("changing scrollback fires a save through to Clerk publicMetadata", async () => {
    const user = makeFakeUser({});
    renderPage(user);

    await act(async () => {
      fireEvent.click(screen.getByTestId("seg-scrollback-1000"));
      await new Promise((r) => setTimeout(r, 600));
    });

    const last = user.writes[user.writes.length - 1]!;
    expect(
      (last["terminalSettings"] as { scrollbackLines: number }).scrollbackLines
    ).toBe(1000);
  });

  it("saving a non-default launcher command opens the consent modal", async () => {
    const user = makeFakeUser({});
    renderPage(user);

    // Type a non-default command and blur to commit.
    const cmd = screen.getByTestId("launcher-command-input") as HTMLInputElement;
    fireEvent.change(cmd, { target: { value: "codex" } });

    await act(async () => {
      fireEvent.blur(cmd);
      await Promise.resolve();
    });

    expect(screen.getByTestId("launcher-consent-modal")).toBeTruthy();
    // No write hit Clerk yet.
    expect(user.writes.length).toBe(0);
  });

  it("consent cancel does NOT write Clerk; reverts the input", async () => {
    const user = makeFakeUser({});
    renderPage(user);

    const cmd = screen.getByTestId("launcher-command-input") as HTMLInputElement;
    fireEvent.change(cmd, { target: { value: "codex" } });
    await act(async () => {
      fireEvent.blur(cmd);
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId("launcher-consent-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("launcher-consent-modal")).toBeNull();
    });
    expect(user.writes.length).toBe(0);
    // Input reverted to the saved (default) command.
    expect(
      (screen.getByTestId("launcher-command-input") as HTMLInputElement).value
    ).toBe("claude");
  });

  it("consent confirm writes both launcher and launcherConsentedAt", async () => {
    const user = makeFakeUser({});
    renderPage(user);

    const cmd = screen.getByTestId("launcher-command-input") as HTMLInputElement;
    fireEvent.change(cmd, { target: { value: "codex" } });
    await act(async () => {
      fireEvent.blur(cmd);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("launcher-consent-confirm"));
      // Wait for the debounce + save.
      await new Promise((r) => setTimeout(r, 600));
    });

    expect(user.writes.length).toBeGreaterThanOrEqual(1);
    const last = user.writes[user.writes.length - 1]!;
    const ts = last["terminalSettings"] as {
      launcher: { command: string; label: string };
      launcherConsentedAt: string | null;
    };
    expect(ts.launcher.command).toBe("codex");
    expect(ts.launcherConsentedAt).toBeTruthy();
    // ISO 8601 shape.
    expect(typeof ts.launcherConsentedAt).toBe("string");
  });

  it("default launcher command saves WITHOUT firing the consent modal", async () => {
    // Setting the default 'claude' command should never trigger consent.
    const user = makeFakeUser({
      terminalSettings: {
        _v: 1,
        position: "bottom",
        theme: "coal",
        font: { family: "JetBrains Mono", size: 13 },
        scrollbackLines: 10000,
        // Stale custom command, no consent record (representing legacy state).
        launcher: { label: "Custom", command: "custom" },
        launcherConsentedAt: null,
      },
    });
    renderPage(user);

    const label = screen.getByTestId("launcher-label-input") as HTMLInputElement;
    const cmd = screen.getByTestId("launcher-command-input") as HTMLInputElement;
    fireEvent.change(label, { target: { value: "Claude" } });
    fireEvent.change(cmd, { target: { value: "claude" } });

    await act(async () => {
      fireEvent.blur(cmd);
      await new Promise((r) => setTimeout(r, 600));
    });

    // No modal.
    expect(screen.queryByTestId("launcher-consent-modal")).toBeNull();
    // A write went through.
    expect(user.writes.length).toBeGreaterThanOrEqual(1);
    const last = user.writes[user.writes.length - 1]!;
    expect(
      (last["terminalSettings"] as { launcher: { command: string } }).launcher
        .command
    ).toBe("claude");
  });

  it("invalid launcher command surfaces a validation error and does NOT save", async () => {
    const user = makeFakeUser({});
    renderPage(user);

    const cmd = screen.getByTestId("launcher-command-input") as HTMLInputElement;
    // Backtick + 0x60 lookalike is fine; smart-quote U+201C is NOT in the regex.
    fireEvent.change(cmd, { target: { value: "bad“cmd" } });

    await act(async () => {
      fireEvent.blur(cmd);
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.getByTestId("launcher-error")).toBeTruthy();
    expect(user.writes.length).toBe(0);
  });
});

describe("TerminalSettingsPage — BroadcastChannel cross-window sync", () => {
  beforeEach(() => {
    cleanup();
  });

  it("a theme change emits a BroadcastChannel event with the merged settings", async () => {
    const user = makeFakeUser({});

    // Spy on BroadcastChannel.
    const received: unknown[] = [];
    const bc = new BroadcastChannel(`dispatch-settings-${user.id}`);
    bc.addEventListener("message", (ev) => {
      received.push(ev.data);
    });

    renderPage(user);

    await act(async () => {
      fireEvent.click(screen.getByTestId("seg-theme-mono"));
      await new Promise((r) => setTimeout(r, 600));
    });
    // Give the BroadcastChannel time to deliver.
    await new Promise((r) => setTimeout(r, 50));

    bc.close();

    // At least one event with the new theme should have been broadcast.
    const msg = received.find(
      (m) =>
        m &&
        typeof m === "object" &&
        (m as { type?: unknown }).type === "dispatch-settings:applied"
    ) as { settings?: { theme?: string } } | undefined;
    expect(msg).toBeTruthy();
    expect(msg?.settings?.theme).toBe("mono");
  });
});
