/**
 * An MCP server over stdio for one person. An agent may ask it to change who holds which role in a workspace;
 * the change runs only after that person signs it with their passkey on Clavis.
 *
 *   cp .env.example .env   # fill it in
 *   pnpm start
 */
import { appendFile } from "node:fs/promises";
import { createAppClient } from "@clavis.nexus/app";
import { createSignatureGate, memoryStore, type SignedCall } from "@clavis.nexus/manu-propria";
import { requireSignatures } from "@clavis.nexus/manu-propria/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
}

const app = createAppClient({
  apiOrigin: "https://api.clavis.nexus",
  appId: requiredEnv("CLAVIS_APP_ID"),
  operatePrivateJwk: requiredEnv("OPERATE_PRIVATE_JWK"),
  masterPublicJwkJson: requiredEnv("MASTER_PUBLIC_JWK_JSON"),
});

// One process serves one person, so waiting requests can live in this process's memory
const gate = createSignatureGate({ app, store: memoryStore() });
const signer = requiredEnv("CLAVIS_SIGNER");

const ROLES = ["member", "admin", "owner"] as const;
type Role = (typeof ROLES)[number];

function article(role: Role): string {
  return role === "admin" || role === "owner" ? `an ${role}` : `a ${role}`;
}

/** Stands in for your product: apply the change. */
async function grantRole(workspace: string, member: string, role: Role): Promise<void> {
  console.error(`[workspace] ${member} -> ${role} in ${workspace}`);
}

/** Keep what was signed next to the change it allowed. `verifySignedCall` checks such a record later. */
async function keep(signature: SignedCall): Promise<void> {
  await appendFile("signed-calls.jsonl", `${JSON.stringify(signature)}\n`);
}

serveStdio(() => {
  const server = new McpServer({ name: "workspace-roles", version: "1.0.0" });
  const signed = requireSignatures(server, {
    gate,
    signer: () => signer,
    // stdout carries the protocol; report on stderr
    onError: (error, { tool }) => console.error(`[${tool}]`, error),
  });

  signed.registerTool(
    "grant_role",
    {
      description: "Give a member of a workspace a role. The person signs the change before it applies.",
      inputSchema: z.object({
        workspace: z.string().min(1),
        member: z.email(),
        role: z.enum(ROLES),
      }),
      annotations: { destructiveHint: true, idempotentHint: true },
      show: ({ workspace, member, role }) => `Make ${member} ${article(role)} of ${workspace}`,
    },
    async ({ workspace, member, role }, _ctx, signature) => {
      await grantRole(workspace, member, role);
      await keep(signature);
      return { content: [{ type: "text", text: `${member} is now ${article(role)} of ${workspace}.` }] };
    },
  );

  return server;
});
