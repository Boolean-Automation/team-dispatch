// dispatch — terminal themes (Phase 2 / Slice 2).
//
// Five named themes per visual-spec §4.2 + §4.4:
//   - coal              (default; the dispatch house dark theme)
//   - paper             (the new light theme; light-bg discipline)
//   - mono              (coal with ANSI flattened toward grayscale)
//   - highContrast      (coal with foreground lifted + brights pushed)
//   - solarizedDark     (the one external preset SEs will expect)
//
// Each theme is an `ITheme` object — these are xterm-scoped, NOT new `:root`
// CSS tokens (visual-spec §5.4 forbids re-tokenizing the app). The values
// trace to the locked Dispatch v2 palette where applicable (visual-spec §4.3).
//
// The string identifier (`coal`/`paper`/...) is what gets stored in Clerk
// publicMetadata in Slice 5; the panel resolves the string → ITheme at mount.

import type { ITheme } from "@xterm/xterm";

/** The named theme set. */
export type ThemeName =
  | "coal"
  | "paper"
  | "mono"
  | "highContrast"
  | "solarizedDark";

/**
 * `coal` — `TERM_THEME_DARK` from visual-spec §4.3. Every value traces to a
 * shell.css `:root` token or the locked `.term` rule. This is the default.
 */
const coal: ITheme = {
  background: "#07101F", // .term bg
  foreground: "#94A3B8", // --text-2
  cursor: "#10B981", // --emerald
  cursorAccent: "#07101F",
  selectionBackground: "#1E293B", // --raised
  black: "#0B1120", // --bg
  red: "#EF4444", // --red
  green: "#10B981", // --emerald
  yellow: "#FBBF24", // --amber
  blue: "#3B82F6", // --blue
  magenta: "#A855F7", // --purple
  cyan: "#6EE7B7", // emerald-bright
  white: "#F1F5F9", // --text
  brightBlack: "#64748B", // --text-3
  brightRed: "#FCA5A5",
  brightGreen: "#6EE7B7",
  brightYellow: "#FCD34D",
  brightBlue: "#93C5FD",
  brightMagenta: "#C4B5FD",
  brightCyan: "#6EE7B7",
  brightWhite: "#FFFFFF",
};

/**
 * `paper` — the visual-spec §4.3 light sibling. Built on the same discipline
 * as `coal`; introduced as an xterm-scoped theme object, NOT new `:root`
 * tokens (would re-tokenize the app — forbidden by §5.4).
 */
const paper: ITheme = {
  background: "#FBFCFE",
  foreground: "#334155", // --border-strong used as ink
  cursor: "#0F9D6E",
  cursorAccent: "#FBFCFE",
  selectionBackground: "#D8E3F0",
  black: "#1E293B",
  red: "#DC2626",
  green: "#0F9D6E",
  yellow: "#B45309",
  blue: "#2563EB",
  magenta: "#9333EA",
  cyan: "#0E7490",
  white: "#475569",
  brightBlack: "#94A3B8",
  brightRed: "#EF4444",
  brightGreen: "#10B981",
  brightYellow: "#D97706",
  brightBlue: "#3B82F6",
  brightMagenta: "#A855F7",
  brightCyan: "#0891B2",
  brightWhite: "#1E293B",
};

/**
 * `mono` — visual-spec §4.4 #3. Low-chroma; ANSI flattened toward
 * --text / --text-2 / --text-3 for the SE who finds color noise distracting.
 * Background unchanged from coal.
 */
const mono: ITheme = {
  background: "#07101F",
  foreground: "#94A3B8",
  cursor: "#F1F5F9", // --text
  cursorAccent: "#07101F",
  selectionBackground: "#1E293B",
  black: "#0B1120",
  red: "#94A3B8", // --text-2 — colors collapse toward the ink palette
  green: "#94A3B8",
  yellow: "#94A3B8",
  blue: "#94A3B8",
  magenta: "#94A3B8",
  cyan: "#94A3B8",
  white: "#F1F5F9",
  brightBlack: "#64748B", // --text-3
  brightRed: "#F1F5F9", // brights climb to --text
  brightGreen: "#F1F5F9",
  brightYellow: "#F1F5F9",
  brightBlue: "#F1F5F9",
  brightMagenta: "#F1F5F9",
  brightCyan: "#F1F5F9",
  brightWhite: "#FFFFFF",
};

/**
 * `highContrast` — visual-spec §4.4 #4. coal with foreground lifted to --text
 * and ANSI brights pushed to full saturation. For the tired-SE-at-6am
 * readability case the SOUL explicitly names.
 */
const highContrast: ITheme = {
  background: "#07101F",
  foreground: "#F1F5F9", // --text, lifted from --text-2
  cursor: "#10B981",
  cursorAccent: "#07101F",
  selectionBackground: "#334155", // --border-strong (stronger than coal's --raised)
  black: "#0B1120",
  red: "#FF4444",
  green: "#00E673",
  yellow: "#FFCC00",
  blue: "#3399FF",
  magenta: "#CC66FF",
  cyan: "#00E5CC",
  white: "#FFFFFF",
  brightBlack: "#94A3B8",
  brightRed: "#FF6666",
  brightGreen: "#33FF99",
  brightYellow: "#FFD633",
  brightBlue: "#66B2FF",
  brightMagenta: "#D699FF",
  brightCyan: "#33FFE0",
  brightWhite: "#FFFFFF",
};

/**
 * `solarizedDark` — visual-spec §4.4 #5. The canonical Solarized values.
 * Included because a terminal that can't do Solarized feels unfinished to a
 * developer audience.
 *
 * Source: https://ethanschoonover.com/solarized/ — base03/02/01/00/0/1/2/3
 * → backgrounds + foregrounds; the 8 accents map to the standard ANSI slots.
 */
const solarizedDark: ITheme = {
  background: "#002B36", // base03
  foreground: "#839496", // base0
  cursor: "#93A1A1", // base1
  cursorAccent: "#002B36",
  selectionBackground: "#073642", // base02
  black: "#073642", // base02
  red: "#DC322F",
  green: "#859900",
  yellow: "#B58900",
  blue: "#268BD2",
  magenta: "#D33682",
  cyan: "#2AA198",
  white: "#EEE8D5", // base2
  brightBlack: "#586E75", // base01
  brightRed: "#CB4B16", // orange
  brightGreen: "#586E75",
  brightYellow: "#657B83", // base00
  brightBlue: "#839496", // base0
  brightMagenta: "#6C71C4", // violet
  brightCyan: "#93A1A1", // base1
  brightWhite: "#FDF6E3", // base3
};

/** The full named theme map. The panel resolves a `ThemeName` → `ITheme`. */
export const themes: Record<ThemeName, ITheme> = {
  coal,
  paper,
  mono,
  highContrast,
  solarizedDark,
};

/**
 * Map a theme to its three CSS-token-equivalent values. The dock surrounding
 * the terminal (toolbar, resize handle, etc.) reads these — when the SE picks
 * `paper` the dock cannot stay coal-dark or the chrome looks broken next to a
 * light terminal. Slice 3 wires this; S2 exposes the mapping.
 */
export interface ThemeTokens {
  bg: string;
  fg: string;
  accent: string;
  cursor: string;
  selection: string;
}

export function themeTokens(name: ThemeName): ThemeTokens {
  const t = themes[name];
  return {
    bg: t.background ?? "#07101F",
    fg: t.foreground ?? "#94A3B8",
    accent: t.green ?? "#10B981",
    cursor: t.cursor ?? "#10B981",
    selection: t.selectionBackground ?? "#1E293B",
  };
}

/** Default theme when no preference is set (visual-spec §4.2). */
export const DEFAULT_THEME: ThemeName = "coal";
