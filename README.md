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

Node.js 24 or later, for both the package and the example, which runs its TypeScript directly.

## Release

`.github/workflows/publish.yml` publishes through npm trusted publishing; no npm token is used. Raise `version` in `packages/manu-propria/package.json` through a pull request to `main`, then, once its checks on `main` have passed, tag the merged commit:

```bash
git tag manu-propria-v1.0.1 && git push origin manu-propria-v1.0.1
```

The workflow stages the package on npm. Before approving it with 2FA under Staged Packages on npmjs.com, check that the commit in the run's summary is on `main` and that the integrity of the `stage` job matches the one npmjs.com shows. The trusted publisher on npm allows staging only.

## Security

Report a vulnerability to security@clavis.nexus. The policy is at [legal.clavis.nexus/en/security](https://legal.clavis.nexus/en/security).

## License

MIT
