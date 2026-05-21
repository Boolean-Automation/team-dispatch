// dispatch — route definitions
// Four routes per plan §Slice 1.

import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { IssuesPage } from "./issues/IssuesPage";
import { TicketDetailPage } from "./ticket/TicketDetailPage";
import { SettingsPage } from "./settings/SettingsPage";
import { AnalyticsPage } from "./analytics/AnalyticsPage";

export function AppRoutes() {
  return (
    <Routes>
      {/* Surface 2: Issues Board (kanban) */}
      <Route path="/" element={<IssuesPage />} />

      {/* Surface 3: Ticket Detail — placeholder in Slice 1, full build in Slice 5 */}
      <Route path="/t/:displayId" element={<TicketDetailPage />} />

      {/* Surface 4: Settings — stub in Phase 1 */}
      <Route path="/settings" element={<SettingsPage />} />

      {/* Surface 5: Analytics — stub in Phase 1 */}
      <Route path="/analytics" element={<AnalyticsPage />} />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
