// dispatch — Topbar component (Issues Board view)
// Ported from app.jsx Topbar + FilterChip + SortChip.
// Slice 4: adds NotificationBell + "New ticket" action.

import React, { useEffect, useRef, useState } from "react";
import Ic from "./Ic.js";
import { NotificationBell } from "./NotificationBell.js";
import type { BoardFilters, SortMode } from "../lib/types.js";
import { ACCOUNTS, ENGINEERS } from "../lib/seed.js";

// ── FilterChip ────────────────────────────────────────────────────────────────

interface FilterOption {
  key: string;
  label: string;
}

interface FilterChipProps {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (v: string) => void;
  allLabel?: string;
}

function FilterChip({
  label,
  value,
  options,
  onChange,
  allLabel = "Any",
}: FilterChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const active = value !== "all";
  const activeLabel = options.find((o) => o.key === value)?.label;

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button
        className={`chip ${active ? "active" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ color: "var(--text-3)" }}>{label}</span>
        <span>{active ? activeLabel : allLabel}</span>
        <span className="chev">
          <Ic.chev />
        </span>
      </button>
      {open && (
        <div className="pop">
          <div
            className="pop-row"
            onClick={() => {
              onChange("all");
              setOpen(false);
            }}
          >
            <span className="check">{value === "all" ? <Ic.check /> : null}</span>
            <span>{allLabel}</span>
          </div>
          <div className="pop-divider" />
          {options.map((o) => (
            <div
              key={o.key}
              className="pop-row"
              onClick={() => {
                onChange(o.key);
                setOpen(false);
              }}
            >
              <span className="check">
                {value === o.key ? <Ic.check /> : null}
              </span>
              <span>{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── SortChip ──────────────────────────────────────────────────────────────────

interface SortChipProps {
  value: SortMode;
  onChange: (v: SortMode) => void;
}

const SORT_OPTS: { key: SortMode; label: string }[] = [
  { key: "sla", label: "SLA urgency" },
  { key: "age-desc", label: "Oldest first" },
  { key: "age-asc", label: "Newest first" },
  { key: "client", label: "Client A → Z" },
];

function SortChip({ value, onChange }: SortChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const currentLabel = SORT_OPTS.find((o) => o.key === value)?.label ?? value;

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button className="chip" onClick={() => setOpen((o) => !o)}>
        <Ic.sort />
        <span>{currentLabel}</span>
        <span className="chev">
          <Ic.chev />
        </span>
      </button>
      {open && (
        <div className="pop">
          {SORT_OPTS.map((o) => (
            <div
              key={o.key}
              className="pop-row"
              onClick={() => {
                onChange(o.key);
                setOpen(false);
              }}
            >
              <span className="check">
                {value === o.key ? <Ic.check /> : null}
              </span>
              <span>{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── NewTicketButton ───────────────────────────────────────────────────────────
//
// Opens a minimal inline dialog to create a hand-crafted ticket.
// Slice 4: fires POST /api/tickets + shows an undo toast.

function NewTicketButton() {
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!accountId.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      if (res.ok) {
        setOpen(false);
        setAccountId("");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <button className="btn-primary" onClick={() => setOpen((o) => !o)}>
        <Ic.plus /> New ticket
      </button>
      {open && (
        <div className="pop" style={{ right: 0, width: 260, padding: "12px" }}>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>New ticket</div>
          <input
            className="pop-input"
            placeholder="Account ID or slug"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            style={{ width: "100%", marginBottom: 8 }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => void handleSubmit()}
              disabled={submitting || !accountId.trim()}
            >
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Topbar ────────────────────────────────────────────────────────────────────

interface TopbarProps {
  filters: BoardFilters;
  setFilters: React.Dispatch<React.SetStateAction<BoardFilters>>;
  sort: SortMode;
  setSort: React.Dispatch<React.SetStateAction<SortMode>>;
  viewLabel: string;
  screenTitle?: string;
}

export function Topbar({
  filters,
  setFilters,
  sort,
  setSort,
  viewLabel,
  screenTitle = "Issues",
}: TopbarProps) {
  const clientOpts = Object.entries(ACCOUNTS).map(([k, v]) => ({
    key: k,
    label: v.displayName,
  }));
  const assigneeOpts: FilterOption[] = [
    { key: "unassigned", label: "Unassigned" },
    ...Object.entries(ENGINEERS).map(([k, v]) => ({ key: k, label: v.name })),
  ];
  const typeOpts: FilterOption[] = [
    { key: "question", label: "Question" },
    { key: "reply", label: "Reply" },
    { key: "thanks", label: "Thanks" },
    { key: "ooo", label: "OOO" },
    { key: "other", label: "Other" },
  ];

  return (
    <div className="topbar">
      <div className="topbar-title">
        <span className="screen-title">{screenTitle}</span>
        <span className="view-name">
          <span className="dot" />
          {viewLabel}
        </span>
      </div>

      <div className="topbar-search">
        <Ic.search />
        <input placeholder="Search tickets, clients, IDs…" readOnly />
        <span className="kbd">⌘K</span>
      </div>

      <div className="filter-row">
        <FilterChip
          label="Client"
          value={filters.client}
          options={clientOpts}
          onChange={(v) => setFilters((f) => ({ ...f, client: v }))}
        />
        <FilterChip
          label="Assignee"
          value={filters.assignee}
          options={assigneeOpts}
          onChange={(v) => setFilters((f) => ({ ...f, assignee: v }))}
        />
        <FilterChip
          label="Type"
          value={filters.type}
          options={typeOpts}
          onChange={(v) => setFilters((f) => ({ ...f, type: v }))}
        />
        <button className="chip add">
          <Ic.plus /> Filter
        </button>
        <span style={{ flex: 1 }} />
        <SortChip value={sort} onChange={setSort} />
      </div>

      <div className="topbar-actions">
        <NotificationBell />
        <NewTicketButton />
      </div>
    </div>
  );
}
