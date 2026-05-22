// dispatch — SettingsNav (Phase 2 / Slice 5).
//
// Left 264px vertical nav per visual-spec §6.1. Reuses `.nav-item` from
// shell.css (`shell.css:144-179`) — has active, hover, icon, and label slots
// already.
//
// In Phase 2 v1, ONLY the Terminal item is enabled. Triggers / Team /
// Connections / Profile render as `.nav-item.is-stub` disabled (visual spec
// §6.1 + §3.5 disabled-stub treatment precedent at `settings.css:76`).

import React from "react";
import { Link } from "react-router-dom";
import Ic from "../shell/Ic.js";

type SettingsTab = "terminal" | "triggers" | "team" | "connections" | "profile";

export interface SettingsNavProps {
  /** Which item is currently active. v1 only `terminal` is reachable. */
  current: SettingsTab;
}

export function SettingsNav(props: SettingsNavProps): React.ReactElement {
  const { current } = props;

  return (
    <aside
      className="settings-nav"
      role="navigation"
      aria-label="Settings sections"
      data-testid="settings-nav"
    >
      <Link
        to="/settings/terminal"
        className={`nav-item ${current === "terminal" ? "active" : ""}`}
        data-testid="settings-nav-terminal"
      >
        <span className="ico">
          <Ic.terminal />
        </span>
        <span className="label">Terminal</span>
      </Link>

      {/* Phase-3 stubs — disabled per visual spec §6.1 */}
      <span
        className="nav-item is-stub"
        aria-disabled="true"
        title="Triggers — coming in a later phase"
        data-testid="settings-nav-triggers"
      >
        <span className="ico">
          <Ic.bolt />
        </span>
        <span className="label">Triggers</span>
      </span>
      <span
        className="nav-item is-stub"
        aria-disabled="true"
        title="Team — coming in a later phase"
        data-testid="settings-nav-team"
      >
        <span className="ico">
          <Ic.user />
        </span>
        <span className="label">Team</span>
      </span>
      <span
        className="nav-item is-stub"
        aria-disabled="true"
        title="Connections — coming in a later phase"
        data-testid="settings-nav-connections"
      >
        <span className="ico">
          <Ic.link />
        </span>
        <span className="label">Connections</span>
      </span>
      <span
        className="nav-item is-stub"
        aria-disabled="true"
        title="Profile — coming in a later phase"
        data-testid="settings-nav-profile"
      >
        <span className="ico">
          <Ic.account />
        </span>
        <span className="label">Profile</span>
      </span>
    </aside>
  );
}
