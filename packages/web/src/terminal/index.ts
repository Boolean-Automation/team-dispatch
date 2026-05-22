// dispatch — terminal module public surface (Phase 2 / Slice 2).
//
// S3+ consumers should import from `terminal/index.ts`, not from the
// individual files. `__forTest` on `scrollbackStore` is INTENTIONALLY hidden
// behind a non-public path so production code can't reach it.

export { Terminal } from "./Terminal.js";
export type { TerminalProps, TerminalHandle } from "./Terminal.js";

export { useTerminal } from "./use-terminal.js";
export type {
  UseTerminalOptions,
  UseTerminalResult,
} from "./use-terminal.js";

export {
  themes,
  themeTokens,
  DEFAULT_THEME,
  type ThemeName,
  type ThemeTokens,
} from "./themes.js";

export { scrollbackStore } from "./scrollback-store.js";
export type {
  ScrollbackStore,
  ChunkRow,
  MetaRow,
} from "./scrollback-store.js";

export {
  installKeyHandler,
  type TerminalWriteTransport,
  type KeyHandlerOptions,
} from "./key-handler.js";

export type {
  TerminalSubscribeTransport,
  TerminalSendTransport,
  TerminalFrame,
  TerminalFrameSubscriber,
} from "./transport-contract.js";

export {
  installTerminalTransportOnWindow,
  getInstalledTerminalTransport,
  getPopoutBridge,
} from "./popout-bridge.js";
export type { PopoutBridge, SettingsChannel } from "./popout-bridge.js";
