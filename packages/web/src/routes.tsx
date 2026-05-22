// dispatch — route definitions.
// Phase 2 / Slice 3 adds `/terminal-popout` outside the authenticated shell.

import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { IssuesPage } from "./issues/IssuesPage";
import { TicketDetailPage } from "./ticket/TicketDetailPage";
import { SettingsPage } from "./settings/SettingsPage";
import { TerminalSettingsPage } from "./routes/settings/terminal";
import { AnalyticsPage } from "./analytics/AnalyticsPage";
import { TerminalPopoutRoute } from "./routes/terminal-popout";

export function AppRoutes() {
  return (
    <Routes>
      {/* Surface 2: Issues Board (kanban) */}
      <Route path="/" element={<IssuesPage />} />

      {/* Surface 3: Ticket Detail */}
      <Route path="/t/:displayId" element={<TicketDetailPage />} />

      {/* Surface 4: Settings — Phase 2/S5 surface.
          `/settings` redirects to `/settings/terminal`; the Terminal sub-tab
          hosts the 5 auto-save controls + consent modal. Other sub-tabs are
          disabled `.is-stub` items in the SettingsNav (Phase 3 surface). */}
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/settings/terminal" element={<TerminalSettingsPage />} />

      {/* Surface 5: Analytics — stub in Phase 1 */}
      <Route path="/analytics" element={<AnalyticsPage />} />

      {/* Phase 2 / S3 — terminal popout window. Outside the auth shell:
          renders the standalone popout, no Rail / Topbar. */}
      <Route path="/terminal-popout" element={<TerminalPopoutRoute />} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
