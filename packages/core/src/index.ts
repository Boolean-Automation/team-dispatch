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
export * from "./services/audit-service.js";
export * from "./services/contact-discovery.js";
export * from "./services/contact-service.js";
export * from "./services/effort-service.js";
export * from "./services/engineer-service.js";
export * from "./services/internal-thread-service.js";
export * from "./services/message-service.js";
export * from "./services/notification-service.js";
export * from "./services/outbox-service.js";
export * from "./services/reassignment-service.js";
export * from "./services/reinforcement-service.js";
export * from "./services/reply-service.js";
export * from "./services/routing.js";
export * from "./services/sla-clock.js";
export * from "./services/status-ladder.js";
export * from "./services/ticket-service.js";
export * from "./services/undo-service.js";

// ── Ingestion ──────────────────────────────────────────────────────────────────
export * from "./ingestion/types.js";
export * from "./ingestion/ingest-message.js";
export * from "./ingestion/adapters/slack-webhook.js";
export * from "./ingestion/adapters/stub-feeder.js";

// ── Slack write-back ──────────────────────────────────────────────────────────
export * from "./slack/write-back.js";

// ── Registry ──────────────────────────────────────────────────────────────────
export * from "./registry/build-registry.js";
