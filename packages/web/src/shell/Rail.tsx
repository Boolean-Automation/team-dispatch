// dispatch — Rail (left sidebar) component
// Ported from shell.jsx Rail function.
// Slice 2: rail footer reads the live Clerk user; falls back to seed SIGNED_IN_KEY.

import React from "react";
import { Link } from "react-router-dom";
import Ic from "./Ic";
import { Avatar } from "./Avatar";
import { ENGINEERS, SIGNED_IN_KEY, DEFAULT_VIEW_COUNTS } from "../lib/seed";
import { useDispatchUser } from "../lib/clerk";
import type { ViewCounts } from "../lib/types";

type CurrentView = "issues" | "accounts" | "analytics" | "settings";

interface RailProps {
  current: CurrentView;
  viewCounts?: Partial<ViewCounts>;
}

export function Rail({ current, viewCounts = {} }: RailProps) {
  const counts: ViewCounts = { ...DEFAULT_VIEW_COUNTS, ...viewCounts };

  // Slice 2: live Clerk user. Falls back to seed data when no Clerk app is
  // configured yet (pre-setup local dev) or when Clerk hasn't loaded.
  const clerkUser = useDispatchUser();
  const footerName = clerkUser?.name ?? ENGINEERS[SIGNED_IN_KEY]?.name ?? SIGNED_IN_KEY;
  const footerRole = clerkUser?.role === "admin" ? "Admin" : "Support eng";
  const footerKey = clerkUser ? null : SIGNED_IN_KEY; // null => Avatar renders from color below
  const footerInitials = clerkUser?.initials;
  const footerColor = clerkUser?.color;

  return (
    <aside className="rail">
      <Link className="rail-brand" to="/">
        <div className="brand-mark" />
        <span className="brand-word">dispatch</span>
        <span className="brand-org">boolean</span>
      </Link>

      <div className="rail-scroll">
        {/* Main navigation */}
        <div className="rail-section">
          <Link
            to="/"
            className={`nav-item ${current === "issues" ? "active" : ""}`}
          >
            <span className="ico">
              <Ic.inbox />
            </span>
            <span className="label">Issues</span>
            <span className="count mono">{counts.all}</span>
          </Link>
          <Link
            to="#"
            className={`nav-item ${current === "accounts" ? "active" : ""}`}
          >
            <span className="ico">
              <Ic.account />
            </span>
            <span className="label">Accounts</span>
            <span className="count mono">{counts.accounts}</span>
          </Link>
          <Link
            to="/analytics"
            className={`nav-item ${current === "analytics" ? "active" : ""}`}
          >
            <span className="ico">
              <Ic.chart />
            </span>
            <span className="label">Analytics</span>
          </Link>
          <Link
            to="/settings"
            className={`nav-item ${current === "settings" ? "active" : ""}`}
          >
            <span className="ico">
              <Ic.gear />
            </span>
            <span className="label">Settings</span>
          </Link>
        </div>

        {/* Saved views — Issues context */}
        {current === "issues" && (
          <div className="rail-section">
            <div className="rail-section-label">Saved views</div>
            {[
              { key: "all", label: "All issues", count: counts.all },
              { key: "unassigned", label: "Unassigned", count: counts.unassigned },
              { key: "mine", label: "My issues", count: counts.mine },
              { key: "by-client", label: "By client", count: counts.all },
            ].map((v) => (
              <button key={v.key} className="nav-item indent">
                <span className="ico">
                  <Ic.bookmark />
                </span>
                <span className="label">{v.label}</span>
                <span className="count mono">{v.count}</span>
              </button>
            ))}
            <div className="rail-section-label" style={{ marginTop: 6 }}>
              Closed
            </div>
            <button className="nav-item indent">
              <span className="ico">
                <Ic.bookmark />
              </span>
              <span className="label">Closed &amp; complete</span>
              <span className="count mono">{counts.closed}</span>
            </button>
          </div>
        )}

        {/* Analytics sub-nav */}
        {current === "analytics" && (
          <div className="rail-section">
            <div className="rail-section-label">Dashboards</div>
            <Link to="/analytics" className="nav-item indent">
              <span className="ico">
                <Ic.bookmark />
              </span>
              <span className="label">Overview</span>
            </Link>
            <Link to="/analytics" className="nav-item indent active">
              <span className="ico">
                <Ic.bookmark />
              </span>
              <span className="label">Workforce</span>
            </Link>
            <Link to="/analytics" className="nav-item indent">
              <span className="ico">
                <Ic.bookmark />
              </span>
              <span className="label">SLA</span>
            </Link>
          </div>
        )}

        {/* Settings sub-nav */}
        {current === "settings" && (
          <div className="rail-section">
            <div className="rail-section-label">Configure</div>
            <Link to="/settings" className="nav-item indent active">
              <span className="ico">
                <Ic.bolt />
              </span>
              <span className="label">Triggers</span>
              <span className="count mono">12</span>
            </Link>
            <Link to="/settings" className="nav-item indent">
              <span className="ico">
                <Ic.user />
              </span>
              <span className="label">Team &amp; OOO</span>
            </Link>
            <Link to="/settings" className="nav-item indent">
              <span className="ico">
                <Ic.link />
              </span>
              <span className="label">Connections</span>
            </Link>
            <Link to="/settings" className="nav-item indent">
              <span className="ico">
                <Ic.gear />
              </span>
              <span className="label">General</span>
            </Link>
          </div>
        )}

        {/* Connections status */}
        <div className="rail-section">
          <div className="rail-section-label">Connections</div>
          <div className="conn-item">
            <span className="conn-logo slack">#</span>
            <span className="conn-label">Slack</span>
            <span className="conn-dot" title="Connected" />
          </div>
          <div className="conn-item">
            <span className="conn-logo gmail">M</span>
            <span className="conn-label">Gmail</span>
            <span className="conn-dot" title="Connected" />
          </div>
          <div className="conn-item">
            <span className="conn-logo bk">bk</span>
            <span className="conn-label">boolean-knowledge</span>
            <span className="conn-dot warn" title="Sync 4h ago" />
          </div>
        </div>
      </div>

      {/* Footer — signed-in SE (live Clerk user in Slice 2+; seed fallback pre-setup) */}
      <div className="rail-footer">
        {clerkUser ? (
          // Clerk user: render an inline avatar with the deterministic color
          <span
            className="avatar"
            title={footerName}
            style={{
              background: footerColor,
              width: 18,
              height: 18,
              fontSize: 9,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "50%",
              color: "#0f172a",
              fontWeight: 600,
            }}
          >
            {footerInitials?.[0]}
          </span>
        ) : (
          <Avatar engKey={footerKey} />
        )}
        <div className="rail-footer-meta">
          <span className="rail-footer-name">{footerName}</span>
          <span className="rail-footer-role">{footerRole}</span>
        </div>
        <span className="rail-footer-chev">
          <Ic.chev />
        </span>
      </div>
    </aside>
  );
}
