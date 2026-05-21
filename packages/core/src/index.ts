// dispatch — @dispatch/core public surface
//
// Exports: entity schemas/types, service functions, registry builder.
// This package is consumed by @dispatch/api only.
// packages/web must NEVER import from @dispatch/core.

// ── Entities ──────────────────────────────────────────────────────────────────
export * from "./entities/account.js";
export * from "./entities/contact.js";
export * from "./entities/message.js";
export * from "./entities/ticket.js";

// ── Services ──────────────────────────────────────────────────────────────────
export * from "./services/account-service.js";
export * from "./services/contact-service.js";
export * from "./services/message-service.js";
export * from "./services/ticket-service.js";

// ── Registry ──────────────────────────────────────────────────────────────────
export * from "./registry/build-registry.js";
