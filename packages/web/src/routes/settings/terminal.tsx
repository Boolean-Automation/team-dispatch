// dispatch — Settings → Terminal page (Phase 2 / Slice 5).
//
// The 5-control auto-save form per visual spec §6.3:
//   1. Panel position    — .seg 2-button (Bottom | Right)
//   2. Launcher shortcut — label + command inputs (+ consent modal on
//      first non-default save)
//   3. Theme             — .seg 5-button + 3-cell swatch preview
//   4. Font              — family select + size .seg 5-button
//   5. Scrollback length — .seg 3-button (1k | 5k | 10k)
//
// Every control change calls `useTerminalSettings().save({ ... })`, which
// debounces (500ms), runs the versioned read-modify-write against Clerk
// publicMetadata, and broadcasts to opener + popout windows.
//
// The launcher control is special: if the SE sets a non-default command for
// the first time (or after consent has expired), the LauncherConsentModal
// from S4 fires BEFORE the save lands on Clerk. Cancel discards the change;
// confirm persists it alongside `launcherConsentedAt = now()`.

import React, { useCallback, useState } from "react";
import { useUser } from "@clerk/clerk-react";
import { Rail } from "../../shell/Rail.js";
import { SettingsNav } from "../../settings/SettingsNav.js";
import { SaveStateChip } from "../../settings/SaveStateChip.js";
import {
  useTerminalSettings,
  type ClerkLikeUser,
  type TerminalSettings,
} from "../../settings/use-terminal-settings.js";
import {
  LauncherConsentModal,
  shouldFireConsentModal,
} from "../../terminal/launcher-consent-modal.js";

/** Bounded preset sets per visual spec §6.3. */
const THEMES: ReadonlyArray<{
  key: TerminalSettings["theme"];
  label: string;
  swatch: { bg: string; fg: string; accent: string };
}> = [
  { key: "coal", label: "Coal", swatch: { bg: "#0B1120", fg: "#E2E8F0", accent: "#10B981" } },
  { key: "paper", label: "Paper", swatch: { bg: "#F8FAFC", fg: "#0F172A", accent: "#0EA5E9" } },
  { key: "mono", label: "Mono", swatch: { bg: "#1F2937", fg: "#D1D5DB", accent: "#9CA3AF" } },
  { key: "highContrast", label: "High-contrast", swatch: { bg: "#000000", fg: "#FFFFFF", accent: "#FFFF00" } },
  { key: "solarizedDark", label: "Solarized-dark", swatch: { bg: "#002B36", fg: "#839496", accent: "#268BD2" } },
] as const;

const FONT_SIZES: ReadonlyArray<TerminalSettings["font"]["size"]> = [
  11, 12, 13, 14, 15,
] as const;

const SCROLLBACK_PRESETS: ReadonlyArray<{
  value: TerminalSettings["scrollbackLines"];
  label: string;
}> = [
  { value: 1000, label: "1k" },
  { value: 5000, label: "5k" },
  { value: 10000, label: "10k" },
] as const;

/** Launcher command regex (S4 plan guardrail).
 *  Whitespace narrowed to literal space — newlines/tabs/control chars
 *  must be rejected (they'd be typed as raw bytes into the shell). */
const LAUNCHER_COMMAND_REGEX =
  /^[\w .\-/'"=,;:!?@#$%^&*()[\]{}|\\<>~+]+$/;

/** Optional injection point used by tests to swap the user source. */
export interface TerminalSettingsPageProps {
  /** Override the Clerk-like user — tests pass a fake; prod reads useUser(). */
  userOverride?: ClerkLikeUser | null;
}

export function TerminalSettingsPage(
  props: TerminalSettingsPageProps = {}
): React.ReactElement {
  // Resolve the Clerk-like user. Production reads from useUser() — but we
  // guard the call so the page renders in tests / pre-Clerk-setup dev where
  // ClerkProvider isn't mounted.
  const clerkUser = useSafeClerkUser();
  const user: ClerkLikeUser | null =
    props.userOverride !== undefined
      ? props.userOverride
      : clerkUser
        ? toClerkLikeUser(clerkUser)
        : null;

  const { settings, save, saveState, retry } = useTerminalSettings({ user });

  // Local launcher-input state — driven by the saved settings but lets the SE
  // type without rebuilding the entire merged object every keystroke.
  const [launcherLabel, setLauncherLabel] = useState(settings.launcher.label);
  const [launcherCommand, setLauncherCommand] = useState(
    settings.launcher.command
  );
  const [launcherError, setLauncherError] = useState<string | null>(null);

  // Consent modal state — holds the pending launcher change while the SE
  // reads the modal copy. Confirming triggers `save()`; cancelling resets.
  const [pendingLauncher, setPendingLauncher] = useState<
    | {
        label: string;
        command: string;
      }
    | null
  >(null);

  // Keep local launcher state in sync when Clerk pushes a remote change
  // (cross-window broadcast or initial load).
  React.useEffect(() => {
    setLauncherLabel(settings.launcher.label);
    setLauncherCommand(settings.launcher.command);
  }, [settings.launcher.label, settings.launcher.command]);

  const handlePositionChange = useCallback(
    (next: TerminalSettings["position"]) => {
      void save({ position: next });
    },
    [save]
  );

  const handleThemeChange = useCallback(
    (next: TerminalSettings["theme"]) => {
      void save({ theme: next });
    },
    [save]
  );

  const handleFontFamilyChange = useCallback(
    (next: string) => {
      void save({ font: { family: next } as never });
    },
    [save]
  );

  const handleFontSizeChange = useCallback(
    (next: TerminalSettings["font"]["size"]) => {
      void save({ font: { size: next } as never });
    },
    [save]
  );

  const handleScrollbackChange = useCallback(
    (next: TerminalSettings["scrollbackLines"]) => {
      void save({ scrollbackLines: next });
    },
    [save]
  );

  /**
   * Launcher save flow:
   *   1. Validate the command against the regex (S4 guardrail).
   *   2. If non-default + no/expired consent: open the modal.
   *   3. Otherwise, save directly.
   */
  const submitLauncher = useCallback(() => {
    setLauncherError(null);
    const label = launcherLabel.trim();
    const command = launcherCommand;
    if (!label || !command) return;
    if (label.length > 32) {
      setLauncherError("Label too long (max 32 characters).");
      return;
    }
    if (command.length > 256) {
      setLauncherError("Command too long (max 256 characters).");
      return;
    }
    if (!LAUNCHER_COMMAND_REGEX.test(command)) {
      setLauncherError(
        "Command contains characters that aren't allowed."
      );
      return;
    }

    if (
      shouldFireConsentModal({
        pendingCommand: command,
        previousConsentedAt: settings.launcherConsentedAt,
      })
    ) {
      setPendingLauncher({ label, command });
      return;
    }
    void save({ launcher: { label, command } });
  }, [
    launcherLabel,
    launcherCommand,
    settings.launcherConsentedAt,
    save,
  ]);

  const handleConsentConfirm = useCallback(
    (decision: { launcherConsentedAt: string }) => {
      if (!pendingLauncher) return;
      void save({
        launcher: pendingLauncher,
        launcherConsentedAt: decision.launcherConsentedAt,
      });
      setPendingLauncher(null);
    },
    [pendingLauncher, save]
  );

  const handleConsentCancel = useCallback(() => {
    setPendingLauncher(null);
    // Revert local input state to the saved value.
    setLauncherLabel(settings.launcher.label);
    setLauncherCommand(settings.launcher.command);
  }, [settings.launcher.label, settings.launcher.command]);

  return (
    <div className="app settings" data-testid="settings-terminal-page">
      <Rail current="settings" />
      <div className="main settings-main" style={{ display: "flex", flexDirection: "column" }}>
        <div className="topbar">
          <div className="topbar-title">
            <span className="screen-title">Settings · Terminal</span>
          </div>
        </div>
        <div className="settings-body">
          <SettingsNav current="terminal" />
          <div className="settings-content">
            <div className="settings-content-head">
              <h1 className="settings-content-title">Terminal</h1>
              <SaveStateChip state={saveState} onRetry={() => void retry()} />
            </div>
            <form
              className="set-form"
              onSubmit={(e) => e.preventDefault()}
              aria-label="Terminal settings"
            >
              {/* 1. Panel position */}
              <SettingRow
                label="Panel position"
                description="Where the terminal panel docks on your screen."
              >
                <div className="seg" role="radiogroup" aria-label="Panel position">
                  <SegButton
                    on={settings.position === "bottom"}
                    onClick={() => handlePositionChange("bottom")}
                    label="Bottom"
                    testId="seg-position-bottom"
                  />
                  <SegButton
                    on={settings.position === "right"}
                    onClick={() => handlePositionChange("right")}
                    label="Right"
                    testId="seg-position-right"
                  />
                </div>
              </SettingRow>

              {/* 2. Launcher shortcut */}
              <SettingRow
                label="Launcher shortcut"
                description="Typed into your shell when you click the launcher button."
              >
                <div className="set-control launcher-control">
                  <input
                    className="set-input"
                    style={{ width: 120 }}
                    type="text"
                    maxLength={32}
                    value={launcherLabel}
                    placeholder="Claude"
                    aria-label="Launcher label"
                    data-testid="launcher-label-input"
                    onChange={(e) => setLauncherLabel(e.target.value)}
                    onBlur={submitLauncher}
                  />
                  <input
                    className="set-input mono"
                    style={{ width: 280 }}
                    type="text"
                    maxLength={256}
                    value={launcherCommand}
                    placeholder="claude"
                    aria-label="Launcher command"
                    data-testid="launcher-command-input"
                    onChange={(e) => setLauncherCommand(e.target.value)}
                    onBlur={submitLauncher}
                  />
                  {launcherError && (
                    <span
                      className="set-error"
                      role="alert"
                      data-testid="launcher-error"
                    >
                      {launcherError}
                    </span>
                  )}
                </div>
              </SettingRow>

              {/* 3. Theme */}
              <SettingRow
                label="Theme"
                description="Color scheme for the embedded terminal."
              >
                <div className="set-control theme-control">
                  <div className="seg" role="radiogroup" aria-label="Terminal theme">
                    {THEMES.map((t) => (
                      <SegButton
                        key={t.key}
                        on={settings.theme === t.key}
                        onClick={() => handleThemeChange(t.key)}
                        label={t.label}
                        testId={`seg-theme-${t.key}`}
                      />
                    ))}
                  </div>
                  <ThemeSwatch
                    swatch={
                      THEMES.find((t) => t.key === settings.theme)!.swatch
                    }
                  />
                </div>
              </SettingRow>

              {/* 4. Font */}
              <SettingRow
                label="Font"
                description="JetBrains Mono is the only family in v1 — more coming."
              >
                <div className="set-control font-control">
                  <select
                    className="set-input"
                    value={settings.font.family}
                    aria-label="Font family"
                    data-testid="font-family-select"
                    onChange={(e) => handleFontFamilyChange(e.target.value)}
                  >
                    <option value="JetBrains Mono">JetBrains Mono</option>
                  </select>
                  <div className="seg" role="radiogroup" aria-label="Font size">
                    {FONT_SIZES.map((s) => (
                      <SegButton
                        key={s}
                        on={settings.font.size === s}
                        onClick={() => handleFontSizeChange(s)}
                        label={`${s}`}
                        testId={`seg-font-size-${s}`}
                      />
                    ))}
                  </div>
                </div>
              </SettingRow>

              {/* 5. Scrollback length */}
              <SettingRow
                label="Scrollback length"
                description="How many lines of past output the terminal keeps in memory."
              >
                <div className="seg" role="radiogroup" aria-label="Scrollback length">
                  {SCROLLBACK_PRESETS.map((p) => (
                    <SegButton
                      key={p.value}
                      on={settings.scrollbackLines === p.value}
                      onClick={() => handleScrollbackChange(p.value)}
                      label={p.label}
                      testId={`seg-scrollback-${p.value}`}
                    />
                  ))}
                </div>
              </SettingRow>
            </form>
          </div>
        </div>
      </div>

      <LauncherConsentModal
        open={pendingLauncher !== null}
        pendingCommand={pendingLauncher?.command ?? ""}
        onConfirm={handleConsentConfirm}
        onCancel={handleConsentCancel}
      />
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface SettingRowProps {
  label: string;
  description: string;
  children: React.ReactNode;
}

function SettingRow(props: SettingRowProps): React.ReactElement {
  return (
    <div className="set-row" data-testid={`set-row-${props.label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div>
        <div className="set-label">{props.label}</div>
        <div className="set-desc">{props.description}</div>
      </div>
      <div className="set-control">{props.children}</div>
    </div>
  );
}

interface SegButtonProps {
  on: boolean;
  onClick: () => void;
  label: string;
  testId: string;
}

function SegButton(props: SegButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      className={props.on ? "on" : ""}
      role="radio"
      aria-checked={props.on}
      onClick={props.onClick}
      data-testid={props.testId}
    >
      {props.label}
    </button>
  );
}

function ThemeSwatch({
  swatch,
}: {
  swatch: { bg: string; fg: string; accent: string };
}): React.ReactElement {
  return (
    <span
      className="theme-swatch"
      aria-hidden="true"
      data-testid="theme-swatch"
    >
      <span
        className="swatch-cell"
        style={{ background: swatch.bg }}
        title="Background"
      />
      <span
        className="swatch-cell"
        style={{ background: swatch.fg }}
        title="Foreground"
      />
      <span
        className="swatch-cell"
        style={{ background: swatch.accent }}
        title="Accent"
      />
    </span>
  );
}

// ── Clerk integration ────────────────────────────────────────────────────────

/**
 * Calls useUser() inside a try/catch so the page mounts cleanly in tests +
 * pre-Clerk-setup dev where ClerkProvider isn't installed.
 *
 * Note: this hook is called UNCONDITIONALLY here (not gated by a publishable
 * key) so React hook order stays stable. The try/catch swallows the throw
 * Clerk emits when used outside a provider.
 */
function useSafeClerkUser():
  | {
      id: string;
      publicMetadata: Record<string, unknown>;
      reload: () => Promise<unknown>;
      update: (patch: {
        publicMetadata: Record<string, unknown>;
      }) => Promise<unknown>;
    }
  | null {
  try {
    const { user } = useUser();
    if (!user) return null;
    return user as unknown as {
      id: string;
      publicMetadata: Record<string, unknown>;
      reload: () => Promise<unknown>;
      update: (patch: {
        publicMetadata: Record<string, unknown>;
      }) => Promise<unknown>;
    };
  } catch {
    return null;
  }
}

/** Adapt the Clerk user object to our ClerkLikeUser interface. */
function toClerkLikeUser(u: {
  id: string;
  publicMetadata: Record<string, unknown>;
  reload: () => Promise<unknown>;
  update: (patch: {
    publicMetadata: Record<string, unknown>;
  }) => Promise<unknown>;
}): ClerkLikeUser {
  return {
    id: u.id,
    get publicMetadata() {
      return u.publicMetadata;
    },
    reload: async () => {
      await u.reload();
    },
    update: async (patch) => {
      await u.update(patch);
    },
  };
}
