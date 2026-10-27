# Agent instructions

## Public

This repository is public, and so is what surrounds it: pull request titles and bodies with their edit history, commit messages, Actions logs and job summaries, and every package published from it.

- Write only what a stranger may read. No secrets, no contact details beyond the published ones, no paths on your machine.
- Cite only what a reader can open from here: files in this repository, other public repositories by name, public pages. Not the design documents, section numbers or paths of private repositories.
- `.github/public-surface.mjs` checks the files in CI and the packed tarball before it is staged. A reference outside this repository that may stay goes in `allowRefs` in `.github/public-surface.json`. What the script cannot know, such as internal names and plans, is listed in `docs/engineering/public-surfaces.md` in ClavisNexus. The script is the same in every public repository; change them together, on the same branch name.

## Git

Agents (Claude Code, Cursor) commit, push, open and merge pull requests, and push tags here without waiting for a person. The rulesets and the hooks below stop mistakes; the weekly `Agent watch` run lists for a person what changed the agents' limits. The full text is `docs/engineering/git-workflow.md` in ClavisNexus.

- Work in a worktree per session, on a branch `claude/<topic>` or `cursor/<topic>` cut from `origin/main`: `git worktree add .worktrees/<topic> -b cursor/<topic> origin/main`.
- `main` takes changes only through a pull request. When the required checks pass, merge it yourself with `gh pr merge --squash`. If `main` has moved, run `gh pr update-branch` and wait for the checks again. Fix a failing check; do not work around it.
- The pull request title becomes the commit message: one or two English sentences saying what changed and why, ending with a full stop, without prefixes such as `feat:`.
- Tags go only on a commit of `main` whose checks have all finished and passed, and never move. A release is a merged version bump, then `manu-propria-vX.Y.Z` on that commit (README, Release). The tag stages the npm package, which a person approves on npmjs.com.
- Leave to a person: changing rulesets, branch protection, repository or organization settings, Actions permissions, secrets and variables, and `git push --no-verify` or any other way around the hooks. Write what you would change and why, and stop. A person who changes a ruleset updates `.github/rulesets.json` with it.
- Once per clone: `git config core.hooksPath .githooks`.
