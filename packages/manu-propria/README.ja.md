# @clavis.nexus/manu-propria

エージェントやジョブが依頼した操作を、利用者が Clavis で Passkey の署名をするまで実行しないためのパッケージです。

[English](./README.md)

エージェントが返金・削除・権限の付与などのツールを呼ぶと、その呼び出しはここで止まります。利用者は Clavis の Connect で、何が起きるかを書いた一行を読み、Passkey で署名します。操作が実行されるのはそのあとで、一つの署名につき一回です。署名した中身（呼び出しの文書）と受領は、App の側に残ります。

- [インストール](#インストール)
- [MCP サーバ](#mcp-サーバ)
- [MCP を使わないとき](#mcp-を使わないとき)
- [署名する中身](#署名する中身)
- [保管と確かめ方](#保管と確かめ方)
- [待ち時間と上限](#待ち時間と上限)
- [ストア](#ストア)
- [エラー](#エラー)
- [安全のための前提](#安全のための前提)

## インストール

```bash
npm install @clavis.nexus/manu-propria @clavis.nexus/app
# MCP サーバでは、こちらも
npm install @modelcontextprotocol/server
```

Node.js 20 以上で動きます。署名を購読している組織（Org）と、ホストの確認を済ませた App が要ります。手順は [Quickstart](https://docs.clavis.nexus/ja/quickstart) にあります。

## MCP サーバ

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
    signer: (ctx) => clavisIdOf(ctx), // この App での利用者の ID
  });

  signed.registerTool(
    "grant_role",
    {
      description: "ワークスペースのメンバーに役割を付けます",
      inputSchema: z.object({ workspace: z.string(), member: z.email(), role: z.enum(["member", "admin", "owner"]) }),
      show: ({ workspace, member, role }) => `${workspace} で ${member} を ${role} にする`,
    },
    async ({ workspace, member, role }, ctx, signature) => {
      await grantRole(workspace, member, role);
      await keep(signature); // 「保管と確かめ方」を見てください
      return { content: [{ type: "text", text: `${member} を ${workspace} の ${role} にしました。` }] };
    },
  );
  return server;
});
```

`signed.registerTool` は `McpServer.registerTool` と同じものを受け、`show` を加えます。ハンドラの第三引数は、署名された呼び出しです。動くサーバは [`examples/mcp-stdio`](../../examples/mcp-stdio) にあります。

エージェントが `grant_role` を呼ぶと、次のように進みます。

1. クライアントが、署名のページのアドレスと一緒に、メッセージを出します。
2. Connect に App の表示名、確認済みのホスト、同じ一行が出ます。利用者が Passkey で署名します。署名できるのは、`signer` が返した利用者の Passkey だけです。
3. ハンドラが一回だけ動きます。結果の `_meta["nexus.clavis/signature"]` は `{ "state": "signed", "request_id": "…", "signed_at": 1791747761 }` です。

この方法で登録したツールは、`tools/list` で `_meta["nexus.clavis/signature"]: { "required": true }` を持ちます。ホストは呼ぶ前に、署名が要るツールだと分かります。

クライアントとモデルが読む文は、既定では英語です。日本語にするときは `messages` で差し替えます。

```ts
const signed = requireSignatures(server, {
  gate,
  signer: (ctx) => clavisIdOf(ctx),
  uiLocales: () => ["ja"],
  messages: {
    request: (show) => `Passkey で署名すると実行します：${show}`,
    declined: (show) => `署名されませんでした：「${show}」。何も実行していません。`,
    expired: (show, tool) => `「${show}」の署名の依頼は期限が切れました。何も実行していません。${tool} をもう一度呼ぶと、新しい依頼になります。`,
  },
});
```

### クライアントごとの答え方

| クライアント | 起きること |
|---|---|
| 2026-07-28 で、URL の elicitation を宣言している | 署名のページを載せた `input_required` を返します。利用者がページを開いたあとは、クライアントが状態だけを付けて呼び直し、サーバは一回につき最大 `holdSeconds` 待ちます。署名が届くまでこれを繰り返します。 |
| 2025 年版でセッションがあり（stdio、セッションのある HTTP サーバ）、URL の elicitation を宣言している | SDK の互換層が、署名のページを `elicitation/create` で送ります。その呼び出しの中でおよそ 50 秒たっても署名が届かなければ、まだ待っていることを結果で伝えます。同じ引数でもう一度呼ぶと、同じ依頼の続きになります。 |
| URL の elicitation を宣言していない。または、状態を持たない HTTP ハンドラに 2025 年版でつないでいる | モデルが利用者に渡すアドレスを、ツールの結果で返します（`withoutUrlElicitation: "link"`、既定）。`"refuse"` にすると、このクライアントでは実行できないと返します。署名のあと同じ引数で呼ぶと実行します。 |
| 利用者が断った、または閉じた | 実行しません。次の呼び出しでは、新しい依頼になります。 |

実行しなかった結果は `isError: true` で、何も実行していないことを書き、`_meta["nexus.clavis/signature"].state` を持ちます。値は `awaiting`（`url` と `expires_at` 付き）、`declined`、`expired`、`no_signer`、`unsupported`、`failed` のどれかです。

### 署名する人

`signer(ctx)` は、この App での利用者の ID を返します。サーバが Clavis の OIDC でサインインさせているなら OIDC の `sub` です。そうでなければ、以前の完了やアカウント連携で受け取って保管した `sub` です。`@clavis.nexus/app` の `allowedSub` と同じ値です。尋ねる相手がいないリクエストでは `undefined` を返します。そのときツールは実行しません。

```ts
signer: async (ctx) => {
  const userId = ctx.http?.authInfo?.extra?.userId; // サーバが呼び出し元を見分ける方法で
  return typeof userId === "string" ? await clavisIdFor(userId) : undefined;
},
```

### オプション

| オプション | 既定 | |
|---|---|---|
| `gate` | | `createSignatureGate` の戻り値です。 |
| `signer(ctx)` | | 上のとおりです。 |
| `holdSeconds` | `45` | 利用者がページを開いたあと、一回の呼び出しで署名を待つ秒数です。クライアントのリクエストのタイムアウトより短くします。 |
| `withoutUrlElicitation` | `"link"` | `"link"` か `"refuse"` です。 |
| `uiLocales(ctx)` | | 利用者の言語（BCP 47）です。Connect の表示を、書いた一行の言語にそろえます。 |
| `context(ctx)` | アクセストークンの OAuth クライアントとリソース | 署名する中身に入ります。画面には出ません。何も入れないときは `undefined` を返します。 |
| `requestState` | | サーバが `requestState` を検証しているときは、同じ codec の `{ mint }` を渡します。 |
| `messages` | 英語 | クライアントとモデルが読む文を差し替えます。 |
| `onError(error, { tool })` | | 実行せずに終えたエラーを受け取ります。 |

## MCP を使わないとき

中にある gate は、どのエージェントのフレームワークやジョブからも使えます。呼び出しの署名を求め、待っているあいだはアドレスを見せ、`signed` になったら実行します。

```ts
import { createSignatureGate, memoryStore } from "@clavis.nexus/manu-propria";

const gate = createSignatureGate({ app, store: memoryStore() });

const call = {
  name: "deploy",
  arguments: { repo: "acme/web", sha: "4f2c9e1", target: "eu-west" },
  show: "acme/web の 4f2c9e1 を eu-west にデプロイする",
  signer: approverId,
};

for (;;) {
  const outcome = await gate.signatureFor(call, { holdMs: 45_000 });
  if (outcome.state === "signed") {
    await deploy(call.arguments);
    await keep(outcome.signature);
    break;
  }
  if (outcome.state === "expired") throw new Error("期限までに署名されませんでした。デプロイしていません");
  if (outcome.fresh) await notify(approverId, `${outcome.show}: ${outcome.url}`);
}
```

`signatureFor` は、初めて見る呼び出しでは依頼を開き、同じ呼び出し（名前、引数、一行、署名する人、context が同じ）をまた受け取ると、同じ依頼の続きを読みます。依頼が署名されるか、期限が切れるか、`forget` されるまで続きます。開いたばかりの依頼はすぐに答えます（`fresh: true`）。利用者がまだアドレスを見ていないからです。二回目からは `holdMs` まで待ちます。

| `outcome.state` | |
|---|---|
| `signed` | 確かめたうえで、この一回の実行のために使用済みにしてあります。すぐに操作を実行し、`outcome.signature` を保管します。 |
| `awaiting` | `url`、`expiresAt`、`started`（利用者が Connect で開いた）、`fresh`、`show` を持ちます。同じ呼び出しで、もう一度尋ねます。 |
| `expired` | 署名されないまま期限が切れました。何も実行しません。もう一度尋ねると、新しい依頼になります。 |

自前の画面で利用者が断ったときなどは、`gate.forget(call)` で待っている依頼を捨てます。

| `createSignatureGate` のオプション | 既定 | |
|---|---|---|
| `app` | | `createAppClient` のクライアントです（`@clavis.nexus/app` 2.1 以上）。 |
| `store` | | 一つのプロセスなら `memoryStore()` です。[ストア](#ストア)を見てください。 |
| `ttlSeconds` | `300` | 利用者が署名を始められる時間（60–900 秒）です。300 秒を超えるときは、developers で App の上限を上げます。 |
| `returnUrl` | なし | 署名のあとに Connect が利用者を戻す先です（確認済みの App ホストの下の https）。省くと利用者は Connect で終わり、エージェントの画面に自分で戻ります。 |
| `pollIntervalMs` | `2500` | 2,000 以上です。 |

## 署名する中身

利用者が署名するのは、呼び出しの文書です。`message_digest` は、その [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) の正準形の SHA-256 を、詰め物なしの Base64URL にしたものです。

```json
{
  "type": "manu_propria.call@1",
  "id": "6f1c1b0e-3f1a-4c55-9c1b-2a1d6c0f7e10",
  "name": "grant_role",
  "arguments": { "member": "ana@example.com", "role": "admin", "workspace": "design" },
  "show": "design で ana@example.com を admin にする",
  "signer": "Pw1vX0r3nJ2bQ8cY4tL6mK9sD1fG7hA5eZ3uI0oP2wE",
  "context": { "mcp": { "client_id": "https://client.example/oauth/metadata.json" } }
}
```

| 欄 | |
|---|---|
| `type` | いつも `manu_propria.call@1` です。この形は変えません。形を変えるときは版を上げます。 |
| `id` | 署名の依頼ごとに新しくなります。一つの署名で実行できるのは一回です。 |
| `name`、`arguments` | 操作と引数です。ハンドラが受け取るものと同じです。引数は素の JSON に限ります（`undefined`、`Date`、`BigInt`、有限でない数、対になっていないサロゲートは入れられません）。 |
| `show` | Connect が見せた一行です。Connect と同じく、NFC にし、続く空白を一つにし、前後の空白を除きます。最大 500 文字です。受領の `envelope.ext["shown@1"].action` と同じ文字列になります。制御文字や、文字の並びを入れ替える双方向の制御（U+202A–U+202E、U+2066–U+2069）を含む一行は、見た目と中身がずれうるので受け付けません。 |
| `signer` | この App での利用者の ID です。受領の `envelope.signer` と同じです。 |
| `context` | あるときだけ入ります。 |

`show` は利用者に向けて書きます。何が、何に起きるかを書き、その呼び出しで変わるものをすべて名指しします。Clavis は利用者が見た一行を署名に束縛します。その一行が引数を正しく言い表しているかは、App のコードが負います。一行と引数はどちらも文書に入るので、あとから誰でも突き合わせられます。

## 保管と確かめ方

`signed` になったら、`SignedCall` 全体を操作の記録と一緒に保管します。

```json
{
  "document": { "type": "manu_propria.call@1", "…": "呼び出しの文書" },
  "messageDigest": "…",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "signer": "…",
  "signedAt": 1791747759,
  "receipt": { "type": "receipt.app@1", "…": "Clavis が副署した受領" }
}
```

`verifySignedCall` は、保管した記録を Clavis に問い合わせずに確かめます。文書が署名された digest になること、受領の署名者と一行が文書と同じであること、受領に Clavis の副署があることを見ます。

```ts
import { receiptKeysFromJwksDocument, verifySignedJwksDocument } from "@clavis.nexus/app";
import { verifySignedCall } from "@clavis.nexus/manu-propria";

const jwks = await (await fetch("https://api.clavis.nexus/.well-known/jwks.json")).json();
await verifySignedJwksDocument(jwks, process.env.MASTER_PUBLIC_JWK_JSON!);
const result = await verifySignedCall(record, { receiptKeys: receiptKeysFromJwksDocument(jwks), appId });
// { ok: true, signature } または { ok: false, reason, detail? }
```

`reason` は `shape`、`document`、`digest`、`signer`、`shown`、`signed_at`、`receipt`（`detail` に受領の検査の結果）のどれかです。受領の形は [受領](https://docs.clavis.nexus/ja/signature#receipt) にあります。

## 待ち時間と上限

- 利用者は `ttlSeconds` のあいだに署名を始めます。それまでに始めた署名は、あとで完了しても構いません。Clavis は完了から 15 分、結果を読めるようにしています。
- Clavis が一つの依頼の status を読ませるのは、1 分に 30 回までです。gate は待つあいだ `pollIntervalMs` ごとに読み、断られたら間隔を空けます。
- 2026-07-28 のクライアントは、一つの呼び出しで繰り返す回数に上限を持ちます（TypeScript の SDK では既定 10 回）。`holdSeconds: 45`、`ttlSeconds: 300` なら、多くて 8 回ほどです。
- Clavis は、署名が完了したときに数えます。[数え方](https://docs.clavis.nexus/ja/signature#count) を見てください。

## ストア

呼び出しのあいだ、待っている依頼（poll secret を含む）と使った署名を持つ場所です。stdio の MCP サーバのようにプロセスが一つなら `memoryStore()` で足ります。複数のプロセスで動くサーバでは、全体で共有し、`use` が全体で原子的に動くストアを使います（例は下のとおりです）。そうしないと、二つのプロセスが同じ署名で同じ呼び出しを二度実行しえます。

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

## エラー

呼び出しをそのままでは署名にできないとき、`signatureFor` は `SignatureGateError` を投げます。

| `code` | |
|---|---|
| `invalid_call` | 名前、引数、一行、署名する人、context のどれかが無いか、形が合いません。 |
| `call_too_large` | 呼び出しの文書が 256 KiB を超えています。 |
| `receipt_mismatch` | Clavis が、別の署名者か別の一行の完了を返しました。実行せず、依頼を捨てます。 |
| `invalid_options` | `createSignatureGate` か `requireSignatures` のオプションが範囲の外です。 |

Clavis のエラーは、`@clavis.nexus/app` の `AppClientError` のまま届きます。たとえば `register_failed` で、`apiError` が `SIGNATURE_CEILING`（今月の上限に達した）や `REGISTRATION_TTL_TOO_LONG`（`ttlSeconds` が App の上限を超えている）のときです。MCP のツールでは、実行せずに呼び出しを終え、コードをメッセージに入れ、`onError` に渡します。

## 安全のための前提

- poll secret はストアの中にだけあります。このパッケージは、ツールの結果、メッセージ、ログに書きません。
- 署名のページのアドレスは、会話を見た人に見えても構いません。完了できるのは、`signer` が返した利用者の Passkey だけです。
- MCP の request state は、次の呼び出しに「待ち続ける」ことを伝えるだけです。何の権限も与えず、書き換えられても何も変わりません。
- 一つの署名で実行できるのは一回です。ハンドラが動く前に、ストアの `use` で使用済みにします。同じ引数の次の呼び出しには、新しい署名が要ります。

## ライセンス

MIT
