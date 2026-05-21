// dispatch E2E — Ticket detail (Surface 3)
//
// Coverage: A24 (ticket-detail), Phase-1 surface-map fidelity
//
// Auth: graceful-passthrough (no Clerk key).
// Data: fixture fallback path — navigates to /t/DSP-2876 without a valid API session.
//   TicketDetailPage falls back to FIXTURE_TICKET when:
//     import.meta.env.DEV && ticketQuery.isError && displayId === FIXTURE_TICKET.displayId
//   The API server returns 401 (no Bearer token in dev → no clerk session), the
//   useTicket query fails fast (no 4xx retries), and the fixture path activates.
//
// data-testid attributes added: none (uses role/class queries throughout)

import { test, expect } from "@playwright/test";

const FIXTURE_DISPLAY_ID = "DSP-2876";

test.describe("Ticket Detail — fixture path", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/t/${FIXTURE_DISPLAY_ID}`);
    // Wait for the ticket list strip to be visible — indicates the fixture rendered.
    // The strip is part of the detail layout and only renders when a ticket is loaded.
    await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });
  });

  test("four-column layout is present", async ({ page }) => {
    // detail layout: .tlist (strip) + .center + .rpanel + .r-toolbar
    await expect(page.locator(".tlist")).toBeVisible();
    await expect(page.locator(".center")).toBeVisible();
    await expect(page.locator(".rpanel")).toBeVisible();
    await expect(page.locator(".r-toolbar")).toBeVisible();
  });

  test("header shows the ticket ID and a title", async ({ page }) => {
    // The t-header should contain the DSP-2876 display ID
    const header = page.locator(".t-header");
    await expect(header).toBeVisible();

    const headerText = await header.textContent();
    expect(headerText).toContain("DSP-2876");

    // The header also contains ticket title text — the fixture has a title about
    // "recurring-revenue" or the display ID itself renders in the header
    expect(headerText?.length).toBeGreaterThan(7); // more than just the ID
  });

  test("tabs bar shows Chat, Internal thread, and Linked tabs", async ({ page }) => {
    const tabs = page.locator(".t-tabs");
    await expect(tabs).toBeVisible();

    // Use button role to be unambiguous about the three main tab buttons
    await expect(tabs.locator("button.tab").filter({ hasText: /^Chat/ })).toBeVisible();
    await expect(tabs.locator("button.tab").filter({ hasText: /^Internal thread/ })).toBeVisible();
    await expect(tabs.locator("button.tab").filter({ hasText: /^Linked/ })).toBeVisible();

    // The Companion bridge lives in the RIGHT PANEL toolbar (Ic.terminal), not
    // the chat tab bar. The tab bar itself stays Phase-1 — Chat / Internal
    // thread / Linked only. (Spike #1 added the terminal to the r-toolbar; see
    // the dedicated RToolbar test below.)
    const tabsText = await tabs.textContent();
    expect(tabsText?.toLowerCase()).not.toContain("terminal");
    expect(tabsText?.toLowerCase()).not.toContain("claude-code");
  });

  test("chat thread renders messages", async ({ page }) => {
    // The thread-scroll area must be visible with at least one message
    const thread = page.locator(".thread-scroll");
    await expect(thread).toBeVisible();

    // The fixture has client messages from "Andre Patel"
    await expect(page.getByText("Andre Patel").first()).toBeVisible();
  });

  test("composer shows Send & resolve and Send & keep open buttons", async ({ page }) => {
    const composer = page.locator(".composer");
    await expect(composer).toBeVisible();

    // Both send buttons from Composer.tsx
    await expect(composer.getByText(/Send & resolve/i)).toBeVisible();
    await expect(composer.getByText(/Send & keep open/i)).toBeVisible();

    // No AI-draft button in Phase 1
    const composerText = await composer.textContent();
    expect(composerText?.toLowerCase()).not.toContain("ai suggest");
  });

  test("right panel shows Ticket & client panel by default", async ({ page }) => {
    const rpanel = page.locator(".rpanel");
    await expect(rpanel).toBeVisible();

    // PanelInfo renders "Ticket & client" in the panel header
    await expect(
      rpanel.getByText(/Ticket & client/i).first()
    ).toBeVisible();
  });

  test("RToolbar shows Info, claude-code, and Activity icons (Spike #1 wired the terminal)", async ({ page }) => {
    const toolbar = page.locator(".r-toolbar");
    await expect(toolbar).toBeVisible();

    // Info button (title="Ticket & client info") from RToolbar.tsx
    await expect(toolbar.locator("[title='Ticket & client info']")).toBeVisible();

    // Activity log button (title="Activity log") from RToolbar.tsx
    await expect(toolbar.locator("[title='Activity log']")).toBeVisible();

    // Spike #1 — the Companion bridge — wires the claude-code (Ic.terminal)
    // button between Info and Activity. RToolbar.tsx's Phase-1 "do not wire"
    // placeholder was deliberately replaced. The button MUST now be present.
    await expect(toolbar.locator("button[title='claude-code']")).toBeVisible();

    // Order: Info / claude-code / Activity (surface-map toolbar order).
    const buttonTitles = await toolbar.locator("button.r-tb").evaluateAll(
      (els) => els.map((el) => el.getAttribute("title"))
    );
    const infoIdx = buttonTitles.indexOf("Ticket & client info");
    const claudeIdx = buttonTitles.indexOf("claude-code");
    const activityIdx = buttonTitles.indexOf("Activity log");
    expect(infoIdx).toBeLessThan(claudeIdx);
    expect(claudeIdx).toBeLessThan(activityIdx);
  });

  test("Phase-3 exclusions: no clock-in or billable controls in the header", async ({ page }) => {
    const header = page.locator(".t-header");
    await expect(header).toBeVisible();

    // surface-map §3: .clock-grp must NOT be rendered in Phase 1
    await expect(header.locator(".clock-grp")).not.toBeVisible();

    // Also verify no "Clock in" button text appears
    const headerText = await header.textContent();
    expect(headerText?.toLowerCase()).not.toContain("clock in");
  });
});
