// dispatch — icon set
// Ported verbatim from shell.jsx Ic object. Each icon is a typed React component.

import React from "react";

interface IconProps {
  className?: string;
}

// We expose each icon as a named export matching the Ic.* namespace in the original.
export const inbox = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M22 13H17l-2 3H9l-2-3H2" />
    <path d="M5.5 6L4 13v4a2 2 0 002 2h12a2 2 0 002-2v-4l-1.5-7a2 2 0 00-2-1.5h-9A2 2 0 005.5 6z" />
  </svg>
);
export const account = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M3 21v-2a4 4 0 014-4h10a4 4 0 014 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);
export const chart = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M3 3v18h18" />
    <path d="M7 14l4-4 3 3 5-6" />
  </svg>
);
export const gear = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </svg>
);
export const search = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);
export const plus = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const chev = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M6 9l6 6 6-6" />
  </svg>
);
export const chevUp = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M18 15l-6-6-6 6" />
  </svg>
);
export const chevLeft = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);
export const chevRight = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M9 6l6 6-6 6" />
  </svg>
);
export const check = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M5 12l5 5L20 7" />
  </svg>
);
export const dots = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="12" cy="5" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="12" cy="19" r="1.5" />
  </svg>
);
export const filter = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M3 5h18M6 12h12M10 19h4" />
  </svg>
);
export const sort = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M11 5h10M11 9h7M11 13h4M3 17l3 3 3-3M6 4v16" />
  </svg>
);
export const bookmark = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
  </svg>
);
export const user = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="12" cy="7" r="4" />
    <path d="M4 21a8 8 0 0116 0" />
  </svg>
);
export const book = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M4 19.5V5a2 2 0 012-2h13v17H6a2 2 0 010-4h13" />
  </svg>
);
export const bell = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 003.4 0" />
  </svg>
);
export const layout = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <rect x="3" y="3" width="7" height="18" rx="1" />
    <rect x="14" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="15" width="7" height="6" rx="1" />
  </svg>
);
// Phase 2 — do not wire. Exported for completeness, toolbar icon omitted from Phase 1.
export const terminal = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M4 6h16v12H4z" />
    <path d="M7 10l3 2-3 2M13 14h4" />
  </svg>
);
export const clock = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const info = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v6M12 7v.5" />
  </svg>
);
export const link = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1" />
    <path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" />
  </svg>
);
export const send = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
  </svg>
);
export const paperclip = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M21 12l-8.5 8.5a5 5 0 01-7-7L14 5a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8-8" />
  </svg>
);
export const edit = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M11 4H4v16h16v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z" />
  </svg>
);
export const bolt = (_p: IconProps) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
  </svg>
);
export const branch = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <circle cx="6" cy="6" r="2" />
    <circle cx="6" cy="18" r="2" />
    <circle cx="18" cy="12" r="2" />
    <path d="M6 8v8M6 12a6 6 0 0010 0" />
  </svg>
);
export const calendar = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <rect x="3" y="5" width="18" height="16" rx="1" />
    <path d="M3 9h18M8 3v4M16 3v4" />
  </svg>
);
export const trash = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M4 7h16M9 7V4h6v3M6 7v13a2 2 0 002 2h8a2 2 0 002-2V7M10 11v6M14 11v6" />
  </svg>
);
export const power = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M12 3v8M5.6 7.6a8 8 0 1012.8 0" />
  </svg>
);
export const arrow = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const drag = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="9" cy="6" r="1.4" />
    <circle cx="9" cy="12" r="1.4" />
    <circle cx="9" cy="18" r="1.4" />
    <circle cx="15" cy="6" r="1.4" />
    <circle cx="15" cy="12" r="1.4" />
    <circle cx="15" cy="18" r="1.4" />
  </svg>
);
// Phase 2 / S3 — popout / dock-toggle icons.
export const popout = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5" />
  </svg>
);
// `splitH` — horizontal split (panel docked at bottom; two horizontal regions).
export const splitH = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="1" />
    <path d="M3 14h18" />
  </svg>
);
// `splitV` — vertical split (panel docked at right; two vertical regions).
export const splitV = (_p: IconProps) => (
  <svg className="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="1" />
    <path d="M14 3v18" />
  </svg>
);

// Convenience namespace object matching original Ic.* usage pattern
const Ic = {
  inbox,
  account,
  chart,
  gear,
  search,
  plus,
  chev,
  chevUp,
  chevLeft,
  chevRight,
  check,
  dots,
  filter,
  sort,
  bookmark,
  user,
  book,
  bell,
  layout,
  terminal,
  clock,
  info,
  link,
  send,
  paperclip,
  edit,
  bolt,
  branch,
  calendar,
  trash,
  power,
  arrow,
  drag,
  popout,
  splitH,
  splitV,
};

export default Ic;
