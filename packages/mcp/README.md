# dispatch MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for the dispatch API. Operators run it as a local stdio process; an MCP client (e.g. Claude Desktop) calls it to read dispatch tickets and accounts.

## Tools

| Tool | Description |
|------|-------------|
| `list_tickets` | List tickets with optional filters (status, assignedTo, accountId, type) |
| `get_ticket` | Get a single ticket by UUID or `DSP-` display id |
| `list_accounts` | List all client accounts |
| `get_account` | Get a single account by UUID |

All tools are read-only in Phase 1. Mutations are deferred to Phase 2.

## Setup

### 1. Get a machine credential

An admin mints a token out-of-band using the mint script:

```bash
# Admin runs this — requires the MCP_SIGNING_SECRET that the API server uses
MCP_SIGNING_SECRET=<signing-secret> pnpm --filter @dispatch/mcp mint-token \
  --user user_clerkUserId123 \
  --role se \
  --expires 1y
```

The script prints the JWT to stdout. Share it with the operator over a secure channel (not Slack plain text).

Available `--expires` values: `Ns` (seconds), `Nm` (minutes), `Nh` (hours), `Nd` (days), `Ny` (years). Default: `1y`.

### 2. Configure the MCP client

Add the dispatch MCP to your MCP client config (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dispatch": {
      "command": "node",
      "args": ["/path/to/team-dispatch/packages/mcp/dist/index.js"],
      "env": {
        "DISPATCH_API_URL": "https://dispatch.paintos.app",
        "DISPATCH_API_KEY": "<your-machine-credential-jwt>"
      }
    }
  }
}
```

Or for local development with `tsx`:

```json
{
  "mcpServers": {
    "dispatch": {
      "command": "npx",
      "args": ["tsx", "/path/to/team-dispatch/packages/mcp/src/index.ts"],
      "env": {
        "DISPATCH_API_URL": "http://localhost:3000",
        "DISPATCH_API_KEY": "<your-machine-credential-jwt>"
      }
    }
  }
}
```

## Auth model

The dispatch MCP uses a machine-credential auth path (auth class d per plan.md §3), distinct from the browser-session path (auth class a). The two credential classes are **mutually non-interchangeable**:

- A Clerk session JWT presented on an MCP route is rejected (wrong audience).
- A machine token presented on a session route is rejected (Clerk SDK rejects non-Clerk tokens).

The machine credential is an HS256 JWT signed with `MCP_SIGNING_SECRET`. Claims:
- `sub` — the operator's Clerk user id
- `role` — `"admin"` or `"se"`
- `aud` — `"dispatch-mcp"` (must match exactly)
- `iss` — `"dispatch"`
- `exp` — token expiry

## Revocation

**Phase 1:** Rotate `MCP_SIGNING_SECRET` (API server env var) to invalidate all outstanding tokens simultaneously. All operators must then re-mint their tokens.

**Phase 2 (deferred):** Per-token revocation via a `mcp_token_revocations` table, allowing single-token invalidation without rotating the signing secret.

## Development

```bash
# Build
pnpm --filter @dispatch/mcp build

# Run tests
pnpm --filter @dispatch/mcp test

# Type-check
pnpm --filter @dispatch/mcp typecheck

# Mint a test token locally
MCP_SIGNING_SECRET=dev-secret pnpm --filter @dispatch/mcp mint-token \
  --user user_local_dev \
  --role se \
  --expires 30d
```
