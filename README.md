# ManuPropria

Run what an agent, a tool or a job asks for only after the user signs it with their passkey on [Clavis](https://clavis.nexus).

エージェントやジョブが依頼した操作を、利用者が Clavis で Passkey の署名をするまで実行しないためのパッケージです。

| Package | |
|---|---|
| [`@clavis.nexus/manu-propria`](packages/manu-propria) | The gate, and `/mcp` for MCP servers. [English](packages/manu-propria/README.md) · [日本語](packages/manu-propria/README.ja.md) |

| Example | |
|---|---|
| [`examples/mcp-stdio`](examples/mcp-stdio) | An MCP server over stdio whose role changes run only after the user signs them. |

## Development

```bash
pnpm install
pnpm --filter @clavis.nexus/manu-propria build
pnpm typecheck
pnpm test
```

Node.js 20 or later for the package; the example runs its TypeScript directly and needs Node.js 22.18 or later.

## Security

Report a vulnerability to security@clavis.nexus. The policy is at [legal.clavis.nexus/en/security](https://legal.clavis.nexus/en/security).

## License

MIT
