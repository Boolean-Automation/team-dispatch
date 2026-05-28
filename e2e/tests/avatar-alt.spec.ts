// dispatch E2E — Card avatar alt attributes (Fix 8, AC-7)
//
// Packet §AC-7: Every card avatar <img> has non-empty `alt` attribute.
// Any alt="" = FAIL.
//
// Dev phase gate-dev.md commit 52d829d shipped:
//   - Avatar.tsx: `alt` prop + `role="img"` + `aria-label`
//   - Card.tsx: passes `alt={t.clientName}` to Avatar
//
// NOTE: Avatar.tsx renders <span> (not <img>) elements with role="img" and
// aria-label. The DOM check is against `[role="img"]` elements, not `<img>` tags.
// The alt text is carried by aria-label per the implementation.
//
// Auth: graceful-passthrough (no Clerk key).
// Data: live board at / with dispatch_dev seed data, or fixture on ticket detail.

import { test, expect } from "@playwright/test";

test.describe("AC-7 — Card avatar alt / aria-label attributes", () => {
  test("all kanban card avatars have non-empty aria-label (issues board)", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".board-wrap")).toBeVisible({ timeout: 15_000 });

    // Avatar renders as <span role="img" aria-label="...">
    // Find all avatar spans within card elements
    const cardAvatars = page.locator(".card .avatar[role='img']");
    const count = await cardAvatars.count();

    // If there are cards on the board, each card avatar must have a non-empty aria-label
    if (count === 0) {
      // No cards in seed — skip, but note it
      console.log("No card avatars found on board — seed may be empty");
      return;
    }

    for (let i = 0; i < count; i++) {
      const avatar = cardAvatars.nth(i);
      const ariaLabel = await avatar.getAttribute("aria-label");
      expect(ariaLabel, `Card avatar ${i} has empty aria-label`).toBeTruthy();
      expect(ariaLabel?.trim().length, `Card avatar ${i} aria-label is empty string`).toBeGreaterThan(0);
    }
  });

  test("ticket detail panel avatars have non-empty aria-label", async ({ page }) => {
    await page.goto("/t/DSP-2876");
    await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });

    // Avatars in the right panel (assignee, collaborators) should have aria-labels
    const panelAvatars = page.locator(".rpanel .avatar[role='img']");
    const count = await panelAvatars.count();

    if (count === 0) {
      console.log("No panel avatars found — skipping panel avatar check");
      return;
    }

    for (let i = 0; i < count; i++) {
      const ariaLabel = await panelAvatars.nth(i).getAttribute("aria-label");
      expect(ariaLabel?.trim().length ?? 0, `Panel avatar ${i} has empty aria-label`).toBeGreaterThan(0);
    }
  });

  test("no avatar element has empty alt or aria-label on ticket detail", async ({ page }) => {
    await page.goto("/t/DSP-2876");
    await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });

    // Check for any img tags with empty alt (should be 0 per AC-7)
    const emptyAltImgs = await page.locator("img[alt='']").count();
    expect(emptyAltImgs).toBe(0);

    // Check avatar spans with empty or missing aria-label
    const avatarsWithEmptyLabel = await page.evaluate(() => {
      const avatars = document.querySelectorAll(".avatar[role='img']");
      return Array.from(avatars).filter((el) => {
        const label = el.getAttribute("aria-label");
        return !label || label.trim() === "";
      }).length;
    });
    expect(avatarsWithEmptyLabel, "Avatars with empty aria-label found").toBe(0);
  });

  test("unassigned Avatar falls back to non-empty aria-label ('Unassigned')", async ({ page }) => {
    await page.goto("/t/DSP-2876");
    await expect(page.locator(".tlist")).toBeVisible({ timeout: 20_000 });

    // Avatar.tsx: when engKey is null → aria-label = alt ?? "Unassigned"
    const unassignedAvatars = page.locator(".avatar.unassigned[role='img']");
    const count = await unassignedAvatars.count();

    for (let i = 0; i < count; i++) {
      const label = await unassignedAvatars.nth(i).getAttribute("aria-label");
      expect(label?.trim().length ?? 0, `Unassigned avatar ${i} has empty aria-label`).toBeGreaterThan(0);
    }
  });
});
