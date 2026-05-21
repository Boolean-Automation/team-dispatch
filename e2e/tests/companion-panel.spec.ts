// dispatch E2E — the PanelTerminal panel in the real ticket-detail surface.
//
// Surface: packages/web/src/ticket/PanelTerminal.tsx — the embedded
// claude-code panel wired into the Phase-1 right-panel state machine (Spike #1).
//
// Auth: graceful-passthrough (no Clerk key) — same as the rest of the suite.
// Data: the /t/DSP-2876 fixture-fallback path (see e2e/README.md).
//
// Coverage:
//   - A14 — with NO Companion process running (the CI default), opening the
//     terminal panel reaches a CLEAN, EXPLICIT "Companion isn't running"
//     failure state. It does not hang, spin forever, or throw an uncaught
//     error. This proves the failure path routes INTO the degradation seam
//     (TerminalTransport → a defined ConnectionState), not into a dead end.
//   - The toolbar wiring — the claude-code (Ic.terminal) button is present and
//     switches the right panel into terminal mode (`panel === "terminal"`).
//
// What is NOT browser-e2e-tested here, and why:
//   The `degraded` state — the seam reached specifically via the
//   `fallback-transport.stub` — cannot be exercised from a browser without an
//   injection hook. `RightPanel` renders `<PanelTerminal ticket={...} />` with
//   no transport prop by design (production always uses the real WS transport);
//   adding a prod injection seam purely for a test would be wrong. That stub
//   path is proven by the web component test
//   packages/web/src/ticket/terminal-transport.test.tsx, which renders
//   `PanelTerminal` with the stub and asserts the `degraded` UI directly. The
//   live `claude` session render is the dev-phase one-off L1 evidence (it
//   needs `claude` auth and an interactive session — not a CI test).

import { test, expect } from "@playwright/test";

const FIXTURE_DISPLAY_ID = "DSP-2876";

test.describe("Companion panel — terminal mode in ticket detail", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/t/${FIXTURE_DISPLAY_ID}`);
    await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });
  });

  test("the claude-code toolbar button switches the right panel into terminal mode", async ({
    page,
  }) => {
    const toolbar = page.locator(".r-toolbar");
    await expect(toolbar).toBeVisible();

    const terminalBtn = toolbar.locator("button[title='claude-code']");
    await expect(terminalBtn).toBeVisible();

    await terminalBtn.click();

    // The right panel head re-titles to "claude-code" in terminal mode.
    const rpanel = page.locator(".rpanel");
    await expect(rpanel.locator(".rpanel-head .title")).toHaveText("claude-code");

    // The `.term` container (the PanelTerminal root) is now rendered.
    await expect(rpanel.locator(".term")).toBeVisible();
  });

  test("A14 — with no Companion running, the panel reaches a clean failure state (no hang, no crash)", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.locator(".r-toolbar button[title='claude-code']").click();

    const term = page.locator(".rpanel .term");
    await expect(term).toBeVisible();

    // No Companion is running in CI → the transport resolves (it does NOT hang)
    // to a defined failure state, rendered as a `.term-fail` block — not the
    // xterm host, and not a spinner stuck forever.
    const fail = term.locator(".term-fail");
    await expect(fail).toBeVisible({ timeout: 15_000 });

    // The failure block has a title, an explanatory message, and a hint —
    // a real, explicit UI state (visual spec §3), not a dead end.
    await expect(fail.locator(".ttl")).toBeVisible();
    await expect(fail.locator(".msg")).toBeVisible();
    await expect(fail.locator(".hint")).toBeVisible();

    // The not-detected / offline state offers a wired Retry — the failure path
    // is recoverable, routed through the seam.
    await expect(fail.locator("button.act")).toHaveText(/Retry connection/i);

    // No uncaught error reached the page — the bridge fails SAFELY (ADR-001).
    expect(consoleErrors).toEqual([]);
  });

  test("A14 — the Retry button re-runs discovery without throwing", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.locator(".r-toolbar button[title='claude-code']").click();
    const fail = page.locator(".rpanel .term .term-fail");
    await expect(fail).toBeVisible({ timeout: 15_000 });

    // Clicking Retry re-runs the transport — it must resolve back to a clean
    // failure state again (still no Companion), not hang or throw.
    await fail.locator("button.act").click();
    await expect(page.locator(".rpanel .term .term-fail")).toBeVisible({
      timeout: 15_000,
    });
    expect(consoleErrors).toEqual([]);
  });

  test("the connection-state header renders in terminal mode (a11y status region)", async ({
    page,
  }) => {
    await page.locator(".r-toolbar button[title='claude-code']").click();

    const rpanel = page.locator(".rpanel");
    // RightPanel.tsx sets role="status" aria-live="polite" on the head in
    // terminal mode (visual spec §2 a11y).
    const head = rpanel.locator(".rpanel-head");
    await expect(head).toHaveAttribute("role", "status");
    await expect(head).toHaveAttribute("aria-live", "polite");

    // The PanelTerminal's own `.term-head` carries the connection dot + label.
    await expect(rpanel.locator(".term .term-head .conn-dot")).toBeVisible();
  });
});
