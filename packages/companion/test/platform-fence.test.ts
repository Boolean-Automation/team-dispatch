/**
 * platform-fence.test.ts — ADR-007 Windows fence.
 *
 * The Companion is Mac/Linux-only (Primary). Windows SEs ride the Parachute
 * — the Phase 3 server-side container. On `process.platform === 'win32'` the
 * Companion logs the ADR-007 message and exits with code 78 (EX_CONFIG).
 *
 * `enforceWindowsFence()` is the testable seam: it takes platform + logger +
 * exit, so we can mock all three without forking a child process.
 */

import { describe, it, expect, vi } from "vitest";
import { enforceWindowsFence } from "../src/main.js";

describe("ADR-007 Windows fence", () => {
  it("logs the ADR-007 message and exits 78 on win32", () => {
    const log = vi.fn<(msg: string) => void>();
    const exit = vi.fn<(code: number) => never>(() => undefined as never);

    enforceWindowsFence("win32", log, exit);

    expect(log).toHaveBeenCalledTimes(1);
    const message = log.mock.calls[0]![0];
    expect(message).toContain("Boolean dispatch Companion does not run on Windows");
    expect(message).toContain("Phase 3 server-side container");
    expect(message).toContain("ADR-007");

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(78);
  });

  it("does NOT log or exit on darwin", () => {
    const log = vi.fn<(msg: string) => void>();
    const exit = vi.fn<(code: number) => never>(() => undefined as never);
    enforceWindowsFence("darwin", log, exit);
    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("does NOT log or exit on linux", () => {
    const log = vi.fn<(msg: string) => void>();
    const exit = vi.fn<(code: number) => never>(() => undefined as never);
    enforceWindowsFence("linux", log, exit);
    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
