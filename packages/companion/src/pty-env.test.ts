/**
 * pty-env.test.ts — child-process env contract for the spawned shell.
 *
 * Spawns the real shell with a polluted parent env (secrets + Anthropic +
 * Claude + OP + Clerk + Slack tokens + arbitrary `*_SECRET`/`*_KEY`/etc.) and
 * asserts via `printenv` in the live PTY that NONE of those names appear in
 * the child while the allowed names DO appear.
 *
 * This is the binding contract: a leaked allowlist would let
 * COMPANION_TOKEN_SECRET into the shell where any command the SE runs could
 * read it.
 */

import { describe, it, expect } from "vitest";
import { PtySession, buildPtyEnv } from "./pty-session.js";

/** Wait until `pred()` is true or the timeout elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

/**
 * The polluted parent env — every name on this list is something the
 * Companion's `process.env` could plausibly carry (we'd never PUT them there
 * deliberately, but on a real SE laptop one of these IS likely set already).
 * The contract is: none of them survive the buildPtyEnv filter.
 */
const POLLUTED_ENV: Record<string, string> = {
  // Anthropic / Claude / Op / Clerk / Slack — direct enumeration of named ones.
  ANTHROPIC_API_KEY: "evil-anthropic",
  CLAUDE_API_KEY: "evil-claude",
  CLAUDE_CONFIG_DIR: "evil-claude-dir",
  CLAUDE_ANYTHING: "evil-claude-anything",
  OP_SERVICE_ACCOUNT_TOKEN: "evil-op",
  CLERK_SECRET_KEY: "evil-clerk-secret",
  CLERK_PUBLISHABLE_KEY: "evil-clerk-pub",
  SLACK_BOT_TOKEN: "evil-slack-bot",
  SLACK_USER_TOKEN: "evil-slack-user",
  COMPANION_TOKEN_SECRET: "evil-companion-secret",
  // Suffix patterns.
  FOO_SECRET: "evil-foo",
  BAR_KEY: "evil-bar",
  BAZ_TOKEN: "evil-baz",
  QUX_PASSWORD: "evil-qux",
};

describe("buildPtyEnv — deny-fence covers the named bad set", () => {
  it("strips every poisoned name from the env it returns", () => {
    const source: NodeJS.ProcessEnv = {
      // Keep some allowed names so we can prove they survive.
      HOME: "/Users/test",
      USER: "test",
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      ...POLLUTED_ENV,
    };
    const filtered = buildPtyEnv(source);

    // Every denied name MUST be absent.
    for (const denied of Object.keys(POLLUTED_ENV)) {
      expect(filtered[denied]).toBeUndefined();
    }

    // Allowed names survive.
    expect(filtered.HOME).toBe("/Users/test");
    expect(filtered.USER).toBe("test");
    expect(filtered.SHELL).toBe("/bin/zsh");
    expect(filtered.PATH).toBe("/usr/bin:/bin");
    expect(filtered.LANG).toBe("en_US.UTF-8");
    expect(filtered.LC_ALL).toBe("en_US.UTF-8");

    // TERM is pinned to xterm-256color.
    expect(filtered.TERM).toBe("xterm-256color");
  });

  it("strips a stray `*_SECRET` / `*_KEY` even with no entry in the explicit deny list", () => {
    const source: NodeJS.ProcessEnv = {
      HOME: "/home/x",
      AWS_SECRET_ACCESS_KEY: "evil",
      STRIPE_SECRET: "evil",
      RANDOM_API_KEY: "evil",
      WEIRD_TOKEN: "evil",
      LAST_PASSWORD: "evil",
    };
    const filtered = buildPtyEnv(source);
    expect(filtered.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(filtered.STRIPE_SECRET).toBeUndefined();
    expect(filtered.RANDOM_API_KEY).toBeUndefined();
    expect(filtered.WEIRD_TOKEN).toBeUndefined();
    expect(filtered.LAST_PASSWORD).toBeUndefined();
  });

  it("XDG_* and LC_* groups survive (prefix-allow)", () => {
    const source: NodeJS.ProcessEnv = {
      HOME: "/home/x",
      XDG_CONFIG_HOME: "/home/x/.config",
      XDG_CACHE_HOME: "/home/x/.cache",
      LC_CTYPE: "en_US.UTF-8",
      LC_TIME: "en_US.UTF-8",
    };
    const filtered = buildPtyEnv(source);
    expect(filtered.XDG_CONFIG_HOME).toBe("/home/x/.config");
    expect(filtered.XDG_CACHE_HOME).toBe("/home/x/.cache");
    expect(filtered.LC_CTYPE).toBe("en_US.UTF-8");
    expect(filtered.LC_TIME).toBe("en_US.UTF-8");
  });
});

describe("PtySession — spawned shell's runtime env honors the contract", () => {
  it(
    "printenv in the live PTY shows no denied names",
    async () => {
      // Use /bin/sh -c 'printenv; exit' so the test is fast on any Unix —
      // login zsh would also work but adds startup time. The contract under
      // test is buildPtyEnv's filter, which is shell-agnostic.
      let buf = "";
      let exited = false;
      const session = new PtySession(
        {
          shellBin: "/bin/sh",
          shellArgs: ["-c", "printenv; exit"],
          cwd: process.cwd(),
          env: { ...process.env, ...POLLUTED_ENV },
        },
        {
          onData: (chunk) => {
            buf += chunk;
          },
          onExit: () => {
            exited = true;
          },
        }
      );

      const ok = await waitFor(() => exited, 8000);
      expect(ok).toBe(true);

      // Parse `KEY=VALUE` lines. PTYs include CRLF; split tolerantly.
      const lines = buf.split(/\r?\n/);
      const names = new Set<string>();
      for (const line of lines) {
        const eq = line.indexOf("=");
        if (eq > 0) names.add(line.slice(0, eq));
      }

      // None of the denied names may appear.
      for (const denied of Object.keys(POLLUTED_ENV)) {
        expect(names.has(denied)).toBe(false);
      }

      // Allowed names that we know are on the parent env DO appear.
      // (These are typically present on a developer's process.env.)
      expect(names.has("HOME")).toBe(true);
      expect(names.has("PATH")).toBe(true);
      expect(names.has("TERM")).toBe(true);

      // node-pty kept the session alive past exit on some platforms; ensure
      // teardown is clean.
      session.kill();
    },
    15_000
  );
});
