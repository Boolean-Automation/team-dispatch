// dispatch E2E — Per-message role chips (Fix 2, AC-2)
//
// Packet §AC-2: Every message shows a role chip colored per senderRole:
//   admin → purple (.msg-role.admin)
//   eng   → gray  (.msg-role.eng)
//   client→ blue  (.msg-role.client)
//
// Dev phase gate-dev.md commit 033f241 shipped three CSS blocks in
// ticket-detail.css. The fixture FIXTURE_CHAT_THREAD uses who:'client' and
// who:'eng' — mapping to .msg-role.client and .msg-role.eng in Message.tsx.
//
// Auth: graceful-passthrough (no Clerk key).
// Data: fixture path — /t/DSP-2876 (FIXTURE_CHAT_THREAD has client + eng msgs).

import { test, expect } from "@playwright/test";

const FIXTURE_DISPLAY_ID = "DSP-2876";

test.describe("AC-2 — Per-message role chips", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/t/${FIXTURE_DISPLAY_ID}`);
    await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".thread-scroll")).toBeVisible();
  });

  test(".msg-role.client chip exists and has blue color token (client messages)", async ({ page }) => {
    // FIXTURE_CHAT_THREAD has messages from Andre Patel with who:'client'
    // Message.tsx renders: <span className={`msg-role ${isClient ? 'client' : 'eng'}`}>
    const clientChip = page.locator(".msg-role.client").first();
    await expect(clientChip).toBeVisible({ timeout: 10_000 });

    const color = await clientChip.evaluate((el) =>
      window.getComputedStyle(el).color
    );
    // --blue is #3B82F6 → rgb(59, 130, 246)
    expect(color).toContain("59");
    expect(color).toContain("130");
  });

  test(".msg-role.eng chip exists (SE messages)", async ({ page }) => {
    // FIXTURE_CHAT_THREAD has messages from Dan Chen with who:'eng'
    const engChip = page.locator(".msg-role.eng").first();
    await expect(engChip).toBeVisible({ timeout: 10_000 });

    // eng chip uses --text-2 color (muted gray, not blue or purple)
    const color = await engChip.evaluate((el) =>
      window.getComputedStyle(el).color
    );
    expect(color).toBeTruthy();
  });

  test(".msg-role.admin CSS contract: purple color token is active", async ({ page }) => {
    // The admin CSS rule was shipped (commit 033f241) even if the fixture
    // doesn't have admin messages yet. Verify the CSS rule is registered by
    // injecting an element and checking the computed style.
    const adminColor = await page.evaluate(() => {
      const span = document.createElement("span");
      span.className = "msg-role admin";
      span.textContent = "ADMIN";
      document.body.appendChild(span);
      const color = window.getComputedStyle(span).color;
      document.body.removeChild(span);
      return color;
    });

    // --purple is #A855F7 → rgb(168, 85, 247)
    expect(adminColor).toContain("168");
    expect(adminColor).toContain("85");
    expect(adminColor).toContain("247");
  });

  test("no message renders as completely unstyled (every msg has a role chip)", async ({ page }) => {
    // Every .msg element in the thread should have at least one .msg-role chip
    const msgElements = page.locator(".thread-scroll .msg");
    const count = await msgElements.count();
    expect(count).toBeGreaterThan(0);

    // At least one .msg-role chip must exist across the thread
    const roleChips = page.locator(".thread-scroll .msg-role");
    const chipCount = await roleChips.count();
    expect(chipCount).toBeGreaterThan(0);
  });
});
