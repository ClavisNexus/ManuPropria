# examples/mcp-stdio

An MCP server over stdio for one user. Its `grant_role` tool changes a member's role in a workspace, and runs only after the user signs the change with their passkey on Clavis.

1. Fill in `.env` from `.env.example`: the app's ID and operate private key from developers, the master public JWK, and the user's ID in the app (`CLAVIS_SIGNER`).
2. Build the package and start the server from the repository root:

   ```bash
   pnpm install
   pnpm --filter @clavis.nexus/manu-propria build
   pnpm --filter example-mcp-stdio start
   ```

3. Add it to an MCP host as a stdio server (`node --env-file=.env server.ts`, run in this directory) and ask the agent to make someone an admin.

Each signed change is appended to `signed-calls.jsonl`, the record `verifySignedCall` checks.
