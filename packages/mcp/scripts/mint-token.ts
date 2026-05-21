// dispatch MCP — admin token minter
//
// Mints a signed HS256 JWT for use as a machine credential (DISPATCH_API_KEY).
// Admins run this out-of-band to issue per-operator MCP tokens.
//
// Usage:
//   MCP_SIGNING_SECRET=<secret> pnpm --filter @dispatch/mcp mint-token \
//     --user <clerkUserId> \
//     --role admin|se \
//     [--expires <duration>]     # e.g. 1y, 90d, 30d (default: 1y)
//
// The <duration> format: <number><unit> where unit is:
//   s = seconds, m = minutes, h = hours, d = days, y = years
//
// Output: the signed JWT, printed to stdout. Drop it into DISPATCH_API_KEY on
// the operator's machine.
//
// Revocation: to invalidate all outstanding tokens, rotate MCP_SIGNING_SECRET.
// Per-token revocation is deferred to Phase 2.

import jwt from "jsonwebtoken";

function parseArgs(): {
  user: string;
  role: string;
  expires: string;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const user = get("--user");
  const role = get("--role") ?? "se";
  const expires = get("--expires") ?? "1y";

  if (!user) {
    console.error("Error: --user <clerkUserId> is required");
    process.exit(1);
  }

  if (role !== "admin" && role !== "se") {
    console.error('Error: --role must be "admin" or "se"');
    process.exit(1);
  }

  return { user, role, expires };
}

function parseDurationToSeconds(duration: string): number {
  const match = /^(\d+)([smhdy])$/.exec(duration);
  if (!match) {
    console.error(
      `Error: invalid --expires format "${duration}". Use <number><unit> e.g. 1y, 90d, 8h`
    );
    process.exit(1);
  }

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 86400;
    case "y":
      return value * 365 * 86400;
    default:
      return value;
  }
}

const signingSecret = process.env.MCP_SIGNING_SECRET;
if (!signingSecret) {
  console.error(
    "Error: MCP_SIGNING_SECRET env var is required to sign the token"
  );
  process.exit(1);
}

const { user, role, expires } = parseArgs();
const expiresInSecs = parseDurationToSeconds(expires);
const now = Math.floor(Date.now() / 1000);

const payload = {
  sub: user,
  role,
  aud: "dispatch-mcp",
  iss: "dispatch",
  iat: now,
  exp: now + expiresInSecs,
};

const token = jwt.sign(payload, signingSecret, {
  algorithm: "HS256",
  // jwt.sign with an explicit exp in the payload uses that value directly
  noTimestamp: true,
});

console.log(token);
console.error(
  `\n[dispatch mint-token] Minted ${role} token for ${user}, expires in ${expires}`
);
