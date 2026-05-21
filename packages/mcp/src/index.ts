// dispatch MCP — stdio server entry point
//
// Operators run this as a local stdio process pointed at a running dispatch
// instance. The MCP client (e.g. Claude Desktop) communicates via stdin/stdout.
//
// Required env vars:
//   DISPATCH_API_URL   — base URL of the dispatch API (e.g. https://dispatch.paintos.app)
//   DISPATCH_API_KEY   — HS256 machine credential JWT minted by an admin
//
// Run:
//   DISPATCH_API_URL=... DISPATCH_API_KEY=... node dist/index.js
// or during development:
//   DISPATCH_API_URL=... DISPATCH_API_KEY=... tsx src/index.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DispatchClient } from "./client.js";
import { registerTools } from "./tools.js";

const apiUrl = process.env.DISPATCH_API_URL;
const apiKey = process.env.DISPATCH_API_KEY;

if (!apiUrl || !apiKey) {
  console.error(
    "dispatch MCP: DISPATCH_API_URL and DISPATCH_API_KEY must be set"
  );
  process.exit(1);
}

const client = new DispatchClient({ apiUrl, apiKey });

const server = new McpServer({
  name: "dispatch",
  version: "0.1.0",
});

registerTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
