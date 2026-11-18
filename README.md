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
git tag manu-propria-v2.0.0 && git push origin manu-propria-v2.0.0
```

The workflow stages the package on npm. Before approving it with 2FA under Staged Packages on npmjs.com, check that the commit in the run's summary is on `main` and that the integrity of the `stage` job matches the one npmjs.com shows. The trusted publisher on npm allows staging only.

## Dependency audit

`ci` runs `pnpm run audit:security` (`scripts/audit-security.mjs`) before install and fails on any high or critical advisory `pnpm audit` reports. The daily schedule runs it too.

An advisory with no fixed release cannot be fixed here, and it stops every pull request at the same step. It passes only through an exception in `scripts/audit-exceptions.json`, and only when all of these hold:

- It is not in the published package's dependencies. `pnpm audit --prod` takes no exception and always fails on high or critical
- No attacker-controlled input reaches it (for example, a build or test tool that only receives values written in this repository)
- Updating dependencies or `overrides` cannot remove it

An exception names the advisory ID, the package, the exact versions found, the reason, the day it was decided (`decided`) and its last day (`until`, at most 30 days after `decided`). A pull request that adds or extends one weakens a required check, so its description states the reason, the impact and when it comes off, and a maintainer confirms it before merge.

The script fails without applying the exception when:

- `until` has passed. Read the advisory again, then drop or extend the exception
- A version or package the exception does not name is found
- A fixed release is published and is older than `minimumReleaseAge` (7 days). Until then it still passes, since the fix cannot be installed yet, and prints the day it can be. After that, update the lockfile and drop the exception
- No advisory matches the exception any more. Drop it
- The audit or registry response cannot be read

Test the script with `pnpm run test:scripts` (no install needed).

## Security

Report a vulnerability to security@clavis.nexus. The policy is at [legal.clavis.nexus/en/security](https://legal.clavis.nexus/en/security).

## License

MIT
