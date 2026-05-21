// dispatch — registry builder tests
//
// Tests:
//  1. Builds Accounts from a fixture _registry.yaml; asserts slug / email_domains
//     / slack_channel_ids / owning_se map correctly.
//  2. A registered internal channel classifies as 'internal' (no Ticket).
//  3. A channel id absent from the registry entirely classifies as 'unknown'
//     (Ticket created, unassigned, origin_class='unknown') — NEVER silently internal.

import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRegistry,
  parseRegistry,
  classifyOrigin,
  type RegistryOriginClass,
} from "../src/registry/build-registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  __dirname,
  "fixtures/_registry.fixture.yaml"
);

describe("buildRegistry", () => {
  it("returns the correct number of client entries", () => {
    const entries = buildRegistry(FIXTURE);
    expect(entries).toHaveLength(3);
  });

  it("maps slug, displayName, emailDomains, slackChannelIds, owningSe correctly", () => {
    const entries = buildRegistry(FIXTURE);
    const alpha = entries.find((e) => e.slug === "test-client-alpha");
    expect(alpha).toBeDefined();
    expect(alpha?.displayName).toBe("Test Client Alpha");
    expect(alpha?.emailDomains).toEqual(["alpha.example.com"]);
    expect(alpha?.slackChannelIds).toEqual(["C_ALPHA_001"]);
    expect(alpha?.owningSe).toBe("user_clerk_alpha");
  });

  it("handles multiple email_domains and slack_channel_ids", () => {
    const entries = buildRegistry(FIXTURE);
    const beta = entries.find((e) => e.slug === "test-client-beta");
    expect(beta?.emailDomains).toEqual(["beta.example.com", "betapaint.com"]);
    expect(beta?.slackChannelIds).toEqual(["C_BETA_001", "C_BETA_002"]);
  });

  it("sets owning_se to null when not provided (null/~)", () => {
    const entries = buildRegistry(FIXTURE);
    const noSe = entries.find((e) => e.slug === "test-client-no-se");
    expect(noSe?.owningSe).toBeNull();
  });
});

describe("classifyOrigin", () => {
  const registry = parseRegistry(FIXTURE);

  it("classifies a registered client channel as 'client'", () => {
    const result = classifyOrigin("C_ALPHA_001", registry);
    expect(result.originClass).toBe("client");
    expect(result.entry?.slug).toBe("test-client-alpha");
  });

  it("classifies a second client channel from a multi-channel entry as 'client'", () => {
    const result = classifyOrigin("C_BETA_002", registry);
    expect(result.originClass).toBe("client");
    expect(result.entry?.slug).toBe("test-client-beta");
  });

  it("classifies an explicitly registered internal channel as 'internal'", () => {
    const result = classifyOrigin("C_INTERNAL_BOOLEAN", registry);
    expect(result.originClass).toBe("internal");
    expect(result.entry).toBeUndefined();
  });

  it("classifies an unknown channel as 'unknown' — NEVER silently internal", () => {
    const result = classifyOrigin("C_RANDOM_UNKNOWN", registry);
    expect(result.originClass).toBe("unknown");
    expect(result.entry).toBeUndefined();
  });

  it("classifies an empty string as 'unknown'", () => {
    const result = classifyOrigin("", registry);
    expect(result.originClass).toBe("unknown");
  });

  it("parses the internal_channel_ids list from the fixture", () => {
    expect(registry.internalChannelIds).toContain("C_INTERNAL_BOOLEAN");
    expect(registry.internalChannelIds).toContain("C_INTERNAL_DEV");
  });
});
