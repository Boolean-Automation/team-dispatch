// dispatch web — vitest setup.
//
// jsdom does not implement a few browser APIs that xterm.js 6 touches on
// `Terminal.open()` (matchMedia for DPR tracking, ResizeObserver). These
// polyfills let the PanelTerminal render tests run under jsdom. They do not
// alter behavior under a real browser, where the native APIs exist.

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

if (typeof globalThis !== "undefined" && !("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub;
}
