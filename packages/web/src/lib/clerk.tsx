// dispatch — Clerk React context wiring
//
// Exports:
//   ClerkProviderWrapper  — wraps the app in Clerk's provider; reads the
//                           publishable key from VITE_CLERK_PUBLISHABLE_KEY.
//   RequireAuth           — protected route wrapper that redirects to Clerk's
//                           sign-in UI if the visitor is not authenticated.
//
// Slice 2 plumbs these into main.tsx and App.tsx.
// All children of <RequireAuth> can call useUser() / useAuth() safely.

import React, { type ReactNode } from "react";
import {
  ClerkProvider,
  SignIn,
  useAuth,
  useUser,
} from "@clerk/clerk-react";
import { setTokenProvider } from "./api-client.js";

// The publishable key is injected at build time by Vite from the environment.
// It's safe to expose to the browser (that's its purpose).
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;

// ── Provider ───────────────────────────────────────────────────────────────────

interface ClerkProviderWrapperProps {
  children: ReactNode;
}

export function ClerkProviderWrapper({ children }: ClerkProviderWrapperProps) {
  if (!PUBLISHABLE_KEY) {
    // No Clerk app configured yet (pre-setup state).
    // Render the children unguarded so Slice-1 UI still works in dev.
    // Plan.md: "The live browser sign-in flow CANNOT be verified without a
    //           real Clerk application + keys (Cody-side setup)."
    return <>{children}</>;
  }

  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      {children}
    </ClerkProvider>
  );
}

// ── Protected route wrapper ────────────────────────────────────────────────────

interface RequireAuthProps {
  children: ReactNode;
}

/**
 * Renders children only when the user is signed in.
 * Unauthenticated → shows the Clerk <SignIn /> component.
 *
 * When VITE_CLERK_PUBLISHABLE_KEY is absent (pre-setup), renders children
 * unconditionally so development still works without a real Clerk app.
 */
export function RequireAuth({ children }: RequireAuthProps) {
  if (!PUBLISHABLE_KEY) {
    // No Clerk app — pass through for local dev without keys
    return <>{children}</>;
  }

  return <AuthGate>{children}</AuthGate>;
}

// Internal: the actual Clerk-aware gate, only rendered when a key exists
function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  // Wire the Clerk session token onto the shared api-client so every API
  // request (board reads, AND the Companion `POST /api/companion/sessions`
  // token mint the bridge depends on) carries `Authorization: Bearer`.
  // Without this the api-client's _tokenProvider is never set and the API
  // 401s every call. Spike #1 Slice 4 remediation — the integrated bridge
  // cannot mint a Companion token otherwise.
  //
  // Set SYNCHRONOUSLY during render (not in an effect): children — including
  // the ticket-detail page whose `useTicket` query fires on its first mount —
  // must see a wired token provider before any queryFn runs. A useEffect
  // races that first query, and `useTicket` does not retry a 4xx, so a
  // racing 401 would permanently kill the query.
  if (isSignedIn) {
    setTokenProvider(() => getToken());
  }

  if (!isLoaded) {
    // Avoid flash — render nothing until Clerk has checked session status
    return null;
  }

  if (!isSignedIn) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "var(--bg-canvas, #0f172a)",
        }}
      >
        <SignIn routing="hash" />
      </div>
    );
  }

  return <>{children}</>;
}

// ── useDispatchUser ────────────────────────────────────────────────────────────

export type DispatchRole = "admin" | "se";

export interface DispatchUser {
  userId: string;
  name: string;
  initials: string;
  /** 6-char hex colour, deterministically derived from userId */
  color: string;
  role: DispatchRole;
}

/**
 * Returns the signed-in SE's dispatch identity.
 * Reads from Clerk's useUser() hook.
 * Returns null when no key is configured or the user is not signed in.
 */
export function useDispatchUser(): DispatchUser | null {
  // If no publishable key, return null — the rail footer will fall back to seed
  if (!PUBLISHABLE_KEY) return null;

  // useUser() is intentionally called after the PUBLISHABLE_KEY guard: when no
  // key is set, ClerkProvider is not mounted and useUser() would throw.
  // PUBLISHABLE_KEY is a build-time constant, so the hook order is stable for
  // any given build. Revisit (mount the provider unconditionally) if/when
  // react-hooks lint is added to the project.
  const { isLoaded, isSignedIn, user } = useUser();

  if (!isLoaded || !isSignedIn || !user) return null;

  const rawRole = user.publicMetadata?.["role"] as string | undefined;
  const role: DispatchRole = rawRole === "admin" ? "admin" : "se";

  const firstName = user.firstName ?? "";
  const lastName = user.lastName ?? "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || user.id;

  const initials = buildInitials(firstName, lastName, user.id);
  const color = deterministicColor(user.id);

  return {
    userId: user.id,
    name: fullName,
    initials,
    color,
    role,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildInitials(first: string, last: string, fallback: string): string {
  if (first && last) return (first[0] + last[0]).toUpperCase();
  if (first) return first.slice(0, 2).toUpperCase();
  // Fallback: first two chars of the Clerk user id
  return fallback.slice(0, 2).toUpperCase();
}

/** Deterministic colour from userId — stable across sessions. */
function deterministicColor(userId: string): string {
  const palette = [
    "#34D399", // emerald
    "#FBBF24", // amber
    "#60A5FA", // blue
    "#C084FC", // purple
    "#F472B6", // pink
    "#22D3EE", // cyan
    "#FB923C", // orange
    "#A3E635", // lime
  ];

  // Simple hash: sum of char codes, mod palette length
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash + userId.charCodeAt(i)) % palette.length;
  }
  return palette[hash] ?? palette[0]!;
}
