# @clavis.nexus/manu-propria

Run what an agent, a tool or a job asks for only after the user signs it with their passkey on Clavis.

[日本語](./README.ja.md)

When an agent calls a tool that refunds, deletes or grants access, this package holds the call. The user opens Clavis Connect, reads one line about what will happen, and signs it with their passkey. Only then does the operation run, once for that signature. Your app keeps the receipt and the exact document that was signed.

- [Install](#install)
- [MCP servers](#mcp-servers)
- [Without MCP](#without-mcp)
- [What gets signed](#what-gets-signed)
- [Keeping and checking a signed call](#keeping-and-checking-a-signed-call)
- [Waiting and limits](#waiting-and-limits)
- [Stores](#stores)
- [Errors](#errors)
- [Security notes](#security-notes)

## Install

```bash
npm install @clavis.nexus/manu-propria @clavis.nexus/app
# MCP servers also need
npm install @modelcontextprotocol/server
```

Node.js 24 or later. You need a Clavis organisation that subscribes to Signature and an app whose host is confirmed; the steps are in the [Quickstart](https://docs.clavis.nexus/en/quickstart).

## MCP servers

```ts
import { createAppClient } from "@clavis.nexus/app";
import { createSignatureGate, memoryStore } from "@clavis.nexus/manu-propria";
import { requireSignatures } from "@clavis.nexus/manu-propria/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

const app = createAppClient({
  apiOrigin: "https://api.clavis.nexus",
  appId: process.env.CLAVIS_APP_ID!,
  operatePrivateJwk: process.env.OPERATE_PRIVATE_JWK!,
  masterPublicJwkJson: process.env.MASTER_PUBLIC_JWK_JSON!,
});
const gate = createSignatureGate({ app, store: memoryStore() });

serveStdio(() => {
  const server = new McpServer({ name: "workspace-roles", version: "1.0.0" });
  const signed = requireSignatures(server, {
    gate,
    signer: (ctx) => clavisIdOf(ctx), // the user's ID in your app on Clavis
  });

  signed.registerTool(
    "grant_role",
    {
      description: "Give a member of a workspace a role",
      inputSchema: z.object({ workspace: z.string(), member: z.email(), role: z.enum(["member", "admin", "owner"]) }),
      show: ({ workspace, member, role }) => `Make ${member} ${role} of ${workspace}`,
    },
    async ({ workspace, member, role }, ctx, signature) => {
      await grantRole(workspace, member, role);
      await keep(signature); // see "Keeping and checking a signed call"
      return { content: [{ type: "text", text: `${member} is now ${role} of ${workspace}.` }] };
    },
  );
  return server;
});
```

`signed.registerTool` takes what `McpServer.registerTool` takes, plus `show`. The handler gets a third argument, the signed call.

When the agent calls `grant_role`:

1. The client shows the message `Sign with your passkey to run this: Make ana@example.com admin of design`, next to the address of the signature page.
2. On Connect the user sees your app's name, its confirmed host and the same line, and signs with their passkey. Only the passkey of the user `signer` names can sign.
3. The handler runs, once. The result carries `_meta["nexus.clavis/signature"]`: `{ "state": "signed", "request_id": "…", "signed_at": 1791747761 }`.

Every tool registered this way carries `_meta["nexus.clavis/signature"]: { "required": true }` in `tools/list`, so a host can tell before calling it.

### How each client is answered

| Client | What happens |
|---|---|
| 2026-07-28, declares URL elicitation | An `input_required` result with the signature page. Once the user has the page, the client retries with only the request state and the server holds each round for up to `holdSeconds` until the signature lands. |
| 2025-era with a session (stdio, a sessionful HTTP server), declares URL elicitation | The SDK's shim sends the page as `elicitation/create`. If the signature has not landed within about 50 seconds of that call, the result says so; calling the tool again with the same arguments picks the same request up. |
| No URL elicitation, or a 2025-era client of a stateless HTTP handler | A tool result with the address for the model to pass on (`withoutUrlElicitation: "link"`, the default), or a refusal (`"refuse"`). Calling again with the same arguments after signing runs it. |
| The user declines or cancels | Not run. The next call opens a new request. |

Results that did not run have `isError: true`, say "Nothing has run", and carry `_meta["nexus.clavis/signature"].state`: `awaiting` (with `url` and `expires_at`), `declined`, `expired`, `no_signer`, `unsupported` or `failed`.

### The signer

`signer(ctx)` returns the user's ID in your app on Clavis: the OIDC `sub` when your server signs users in with Clavis, or the `sub` you kept from an earlier completion or account link. It is the same value as `allowedSub` in `@clavis.nexus/app`. Return `undefined` when the request has nobody to ask; the tool then does not run.

```ts
signer: async (ctx) => {
  const userId = ctx.http?.authInfo?.extra?.userId; // however your server identifies the caller
  return typeof userId === "string" ? await clavisIdFor(userId) : undefined;
},
```

### Options

| Option | Default | |
|---|---|---|
| `gate` | | From `createSignatureGate`. |
| `signer(ctx)` | | See above. |
| `holdSeconds` | `45` | How long one round waits for the signature once the user has the page. Keep it under your clients' request timeout. |
| `withoutUrlElicitation` | `"link"` | `"link"` or `"refuse"`. |
| `uiLocales(ctx)` | | The user's languages (BCP 47), so Connect matches the language of your line. |
| `context(ctx)` | the access token's OAuth client and resource | Bound into what is signed; not shown. Return `undefined` to bind nothing. |
| `requestState` | | If your server verifies `requestState`, pass `{ mint }` from the same codec. |
| `messages` | English | Replace any of the texts the client and the model read. |
| `onError(error, { tool })` | | Errors that ended a call without running it. |

## Without MCP

The gate underneath works with any agent framework or job: ask for the signature of a call, show the address while it waits, run on `signed`.

```ts
import { createSignatureGate, memoryStore } from "@clavis.nexus/manu-propria";

const gate = createSignatureGate({ app, store: memoryStore() });

const call = {
  name: "deploy",
  arguments: { repo: "acme/web", sha: "4f2c9e1", target: "eu-west" },
  show: "Deploy acme/web 4f2c9e1 to eu-west",
  signer: approverId,
};

for (;;) {
  const outcome = await gate.signatureFor(call, { holdMs: 45_000 });
  if (outcome.state === "signed") {
    await deploy(call.arguments);
    await keep(outcome.signature);
    break;
  }
  if (outcome.state === "expired") throw new Error("not signed in time; nothing was deployed");
  if (outcome.fresh) await notify(approverId, `${outcome.show}: ${outcome.url}`);
}
```

`signatureFor` opens a request the first time it sees a call and picks the same request up when it sees the same call again (same name, arguments, line, signer and context), until the request is signed, lapses or is forgotten. A request it has just opened answers at once (`fresh: true`), because the user has to see the address first; on later calls it waits up to `holdMs`.

| `outcome.state` | |
|---|---|
| `signed` | Verified and claimed for this run. Run the operation now; `outcome.signature` is the record to keep. |
| `awaiting` | `url`, `expiresAt`, `started` (the user has opened it on Connect), `fresh`, `show`. Ask again with the same call. |
| `expired` | The request lapsed without a signature. Nothing runs; asking again opens a new request. |

`gate.forget(call)` drops the waiting request, for example after the user declines in your own interface.

| `createSignatureGate` option | Default | |
|---|---|---|
| `app` | | A client from `createAppClient` (`@clavis.nexus/app` 2.1 or later). |
| `store` | | `memoryStore()` for one process; see [Stores](#stores). |
| `ttlSeconds` | `300` | How long the user has to start signing, 60–900. More than 300 needs the app's limit raised on developers. |
| `returnUrl` | none | Where Connect sends the user after signing (https, under your app's confirmed host). Without it the user finishes on Connect and goes back to the agent. |
| `pollIntervalMs` | `2500` | 2,000 or more. |

## What gets signed

The user signs a call document. `message_digest` is its SHA-256, Base64URL without padding, over its [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical form:

```json
{
  "type": "manu_propria.call@1",
  "id": "6f1c1b0e-3f1a-4c55-9c1b-2a1d6c0f7e10",
  "name": "grant_role",
  "arguments": { "member": "ana@example.com", "role": "admin", "workspace": "design" },
  "show": "Make ana@example.com admin of design",
  "signer": "Pw1vX0r3nJ2bQ8cY4tL6mK9sD1fG7hA5eZ3uI0oP2wE",
  "context": { "mcp": { "client_id": "https://client.example/oauth/metadata.json" } }
}
```

| Member | |
|---|---|
| `type` | Always `manu_propria.call@1`. This shape does not change; another shape gets another version. |
| `id` | New for every signature request, so one signature authorizes one run. |
| `name`, `arguments` | The operation and its arguments, exactly as the handler receives them. Arguments must be plain JSON: no `undefined`, `Date`, `BigInt`, non-finite numbers or lone surrogates. |
| `show` | The line Connect showed, normalized as Connect binds it: NFC, runs of whitespace as one space, trimmed, at most 500 characters. The receipt's `envelope.ext["shown@1"].action` is the same string. A line with control characters or bidirectional overrides (U+202A–U+202E, U+2066–U+2069), which can make it read differently from what it contains, is refused. |
| `signer` | The user's ID in your app on Clavis. The receipt's `envelope.signer` is the same. |
| `context` | Present only when there is one. |

Write `show` for the user: say what will happen and to what, and name everything the call changes. Clavis binds the line the user saw into the signature; whether the line describes the arguments is up to your code, and since both are in the document, anyone can compare them later.

## Keeping and checking a signed call

On `signed`, keep the whole `SignedCall` with the operation's record:

```json
{
  "document": { "type": "manu_propria.call@1", "…": "the call document" },
  "messageDigest": "…",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "signer": "…",
  "signedAt": 1791747759,
  "receipt": { "type": "receipt.app@1", "…": "the receipt Clavis countersigned" }
}
```

`verifySignedCall` checks a kept record without asking Clavis: the document hashes to the signed digest, the receipt names the same signer and the same line, and Clavis countersigned the receipt.

```ts
import { receiptKeysFromJwksDocument, verifySignedJwksDocument } from "@clavis.nexus/app";
import { verifySignedCall } from "@clavis.nexus/manu-propria";

const jwks = await (await fetch("https://api.clavis.nexus/.well-known/jwks.json")).json();
await verifySignedJwksDocument(jwks, process.env.MASTER_PUBLIC_JWK_JSON!);
const result = await verifySignedCall(record, { receiptKeys: receiptKeysFromJwksDocument(jwks), appId });
// { ok: true, signature } or { ok: false, reason, detail? }
```

`reason` is `shape`, `document`, `digest`, `signer`, `shown`, `signed_at` or `receipt` (with `detail` from the receipt check). The receipt's shape is in [Receipt](https://docs.clavis.nexus/en/signature#receipt).

## Waiting and limits

- The user has `ttlSeconds` to start signing. A signature started before then can finish afterwards; Clavis keeps the result readable for 15 minutes after it completes.
- Clavis lets an app read one request's status 30 times a minute. The gate reads every `pollIntervalMs` while holding and backs off when a read is refused.
- A 2026-07-28 client runs a limited number of rounds for one call (10 by default in the TypeScript SDK). With `holdSeconds: 45` and `ttlSeconds: 300` a call takes at most about 8.
- Clavis counts a signature when it completes; see [Counts](https://docs.clavis.nexus/en/signature#count).

## Stores

Where waiting requests (with their poll secrets) and used signatures are kept between calls. `memoryStore()` is right for one process, such as an MCP server over stdio; a server on more than one process needs a shared store whose `use` is atomic across all of them, as below.

```ts
import type { SignatureStore } from "@clavis.nexus/manu-propria";
import type { Redis } from "ioredis";

export function redisStore(redis: Redis): SignatureStore {
  return {
    async get(key) {
      const value = await redis.get(`signature:${key}`);
      return value ? JSON.parse(value) : undefined;
    },
    async set(key, value, ttlSeconds) {
      await redis.set(`signature:${key}`, JSON.stringify(value), "EX", ttlSeconds);
    },
    async delete(key) {
      await redis.del(`signature:${key}`);
    },
    async use(requestId, ttlSeconds) {
      return (await redis.set(`signature-used:${requestId}`, "1", "EX", ttlSeconds, "NX")) === "OK";
    },
  };
}
```

## Errors

`signatureFor` throws `SignatureGateError` when the call cannot be signed as given:

| `code` | |
|---|---|
| `invalid_call` | A missing or malformed name, arguments, line, signer or context. |
| `call_too_large` | The call document is over 256 KiB. |
| `receipt_mismatch` | Clavis reported a completion for another signer or another line. Nothing runs and the request is dropped. |
| `invalid_options` | From `createSignatureGate` or `requireSignatures`. |

Errors from Clavis come through as `AppClientError` from `@clavis.nexus/app`: for example `register_failed` with `apiError` `SIGNATURE_CEILING` (this month's limit is reached) or `REGISTRATION_TTL_TOO_LONG` (`ttlSeconds` is over the app's limit). In MCP tools they end the call without running it, with the code in the message, and reach `onError`.

## Security notes

- The poll secret stays in the store. It never appears in a tool result, a message or a log written by this package.
- The signature page's address can be seen by anyone who sees the conversation; only the passkey of the user `signer` names can complete it.
- The MCP request state only tells the next round to keep waiting; it grants nothing, and a tampered one changes nothing.
- One signature runs one call: the store's `use` claims it before the handler runs, and the next call with the same arguments needs a new signature.

## License

MIT
