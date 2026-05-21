// dispatch — auth utility helpers for the web layer
//
// Provides a function to get the Clerk session token for attaching to API
// requests.  The actual bearer-token attachment lives in api-client.ts.

// Re-export the role type so consumers only need one import
export type { DispatchRole, DispatchUser } from "./clerk.js";

/**
 * Returns the Clerk session token for use in Authorization headers.
 * Call inside a component via the useAuth hook; this file provides the
 * shape that api-client.ts expects.
 */
export type TokenProvider = () => Promise<string | null>;
