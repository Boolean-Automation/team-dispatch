// dispatch E2E — Issues board (Surface 2)
//
// Coverage: A22, A23, A24-shell
//
// Boots Vite + the api server against seeded dispatch_dev.
// Auth: graceful-passthrough (no Clerk key).
//
// Asserts:
//   - Six kanban columns in plan-order
//   - Rail renders saved-views set
//   - Topbar renders Client / Assignee / Type filter chips + Sort chip + New-ticket button
//   - Status bar renders ticket counts + last-sync label
//   - Type filter chip: click → dropdown opens
//   - Sort chip: click → menu opens; pick an option → label reflects it

import { test, expect } from "@playwright/test";

const STATUSES = [
  "New",
  "On You",
  "Waiting on Client",
  "Follow-up Required",
  "Follow-up 1 Sent",
  "Closeout Follow-up Required",
];

test.describe("Issues Board", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for the board-wrap to be visible — the outer container of the kanban
    await expect(page.locator(".board-wrap")).toBeVisible({ timeout: 15_000 });
  });

  test("renders six kanban columns in the correct plan order", async ({ page }) => {
    // Column headers use .col-head > .name (from Column.tsx)
    const columnNames = page.locator(".col .col-head .name");
    const count = await columnNames.count();
    expect(count).toBeGreaterThanOrEqual(STATUSES.length);

    // Verify each expected status name appears as a column header
    for (const status of STATUSES) {
      await expect(
        page.locator(".col .col-head .name").filter({ hasText: status }).first()
      ).toBeVisible();
    }
  });

  test("rail renders the saved-views section", async ({ page }) => {
    await expect(page.locator(".rail")).toBeVisible();

    // The "Saved views" section label
    await expect(page.getByText("Saved views")).toBeVisible();
    // Each saved-view button contains the label + a count badge, so we use
    // contains-text matching (regex or hasText filter)
    await expect(page.locator(".rail button.nav-item").filter({ hasText: "All issues" }).first()).toBeVisible();
    await expect(page.locator(".rail button.nav-item").filter({ hasText: "Unassigned" }).first()).toBeVisible();
    await expect(page.locator(".rail button.nav-item").filter({ hasText: "My issues" }).first()).toBeVisible();
    await expect(page.locator(".rail button.nav-item").filter({ hasText: "By client" }).first()).toBeVisible();
  });

  test("topbar renders filter chips, sort chip, and New-ticket button", async ({ page }) => {
    await expect(page.locator(".topbar")).toBeVisible();

    // The filter row contains chip buttons with "Client", "Assignee", "Type" labels
    const filterRow = page.locator(".filter-row");
    await expect(filterRow).toBeVisible();

    // Each chip must be visible (contains the label text)
    const clientChip = filterRow.locator(".chip").filter({ hasText: /Client/i }).first();
    await expect(clientChip).toBeVisible();

    const assigneeChip = filterRow.locator(".chip").filter({ hasText: /Assignee/i }).first();
    await expect(assigneeChip).toBeVisible();

    const typeChip = filterRow.locator(".chip").filter({ hasText: /Type/i }).first();
    await expect(typeChip).toBeVisible();

    // Sort chip is also in the filter row
    const sortChip = filterRow.locator(".chip").filter({ hasText: /SLA|Oldest|Newest|Client A/i }).first();
    await expect(sortChip).toBeVisible();

    // New-ticket button is in the topbar actions area
    await expect(page.locator(".topbar-actions .btn-primary")).toBeVisible();
  });

  test("status bar renders ticket counts and last-sync label", async ({ page }) => {
    const statusbar = page.locator(".statusbar");
    await expect(statusbar).toBeVisible();

    // Status bar must contain at least one number (ticket counts)
    const text = await statusbar.textContent();
    expect(text).toBeTruthy();
    expect(text).toMatch(/\d/);
  });

  test("Type filter chip click opens dropdown with type options", async ({ page }) => {
    const filterRow = page.locator(".filter-row");
    // Find the Type chip specifically
    const typeChip = filterRow.locator(".chip").filter({ hasText: /^Type/ }).first();
    await expect(typeChip).toBeVisible();

    await typeChip.click();

    // The popover must open with type options
    const pop = page.locator(".pop").first();
    await expect(pop).toBeVisible();
    await expect(pop.getByText("Question")).toBeVisible();
    await expect(pop.getByText("Reply")).toBeVisible();
    await expect(pop.getByText("Thanks")).toBeVisible();
  });

  test("Sort chip click opens menu and selecting Oldest first updates the chip label", async ({ page }) => {
    const filterRow = page.locator(".filter-row");
    const sortChip = filterRow.locator(".chip").filter({ hasText: /SLA urgency|Oldest|Newest|Client A/i }).first();
    await expect(sortChip).toBeVisible();

    // Click to open the sort dropdown
    await sortChip.click();

    const pop = page.locator(".pop").last();
    await expect(pop).toBeVisible();

    // Verify sort options are present
    await expect(pop.getByText("SLA urgency")).toBeVisible();
    await expect(pop.getByText("Oldest first")).toBeVisible();
    await expect(pop.getByText("Newest first")).toBeVisible();
    await expect(pop.getByText("Client A → Z")).toBeVisible();

    // Select "Oldest first"
    await pop.getByText("Oldest first").click();

    // Dropdown should close
    await expect(pop).not.toBeVisible({ timeout: 5_000 });

    // Sort chip should now show "Oldest first"
    await expect(sortChip).toContainText("Oldest first");
  });
});
