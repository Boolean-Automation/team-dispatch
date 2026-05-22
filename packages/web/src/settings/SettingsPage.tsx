// dispatch — Settings index page (Phase 2 / Slice 5).
//
// In Phase 1 this rendered a single "coming later" stub. Phase 2 lifts the
// shell into a proper 264px nav + tab body. The only tab implemented in this
// phase is `/settings/terminal` — every other tab is a disabled `.is-stub`.
//
// Hitting `/settings` directly redirects to `/settings/terminal` since
// Terminal is the only enabled section in Phase 2.

import React from "react";
import { Navigate } from "react-router-dom";

export function SettingsPage() {
  return <Navigate to="/settings/terminal" replace />;
}
