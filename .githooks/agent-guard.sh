#!/bin/sh
# Shell-command guard for coding agents, run by Cursor (.cursor/hooks.json) and Claude Code
# (.claude/settings.json). It refuses what an agent leaves to a person: changing rulesets, branch
# protection, repository or organization settings, secrets and variables, and skipping or
# replacing the git hooks. It catches mistakes; it does not stop a determined bypass.
# Usage: agent-guard.sh cursor|claude, with the hook's JSON on stdin.

mode="$1"
input=$(cat)
cmd=$(printf '%s' "$input" | /usr/bin/jq -r '.command // .tool_input.command // empty' 2>/dev/null) || cmd=$input
[ -n "$cmd" ] || cmd=$input

reason=""
has() { printf '%s' "$cmd" | grep -Eq -- "$1"; }

if has 'git[^|;&]*[[:space:]]push([[:space:]][^|;&]*)?[[:space:]]--no-verify'; then
  reason="git push --no-verify skips the pre-push hook."
elif has 'core\.hooksPath' && ! has 'core\.hooksPath[[:space:]]+\.githooks([[:space:]]|$)' && ! has 'core\.hooksPath[[:space:]]*($|[|;&])'; then
  reason="core.hooksPath stays .githooks."
elif has 'gh[[:space:]]+repo[[:space:]]+(edit|delete|archive|unarchive|rename)'; then
  reason="repository settings are changed by a person."
elif has 'gh[[:space:]]+(secret|variable)[[:space:]]+(set|delete|remove)'; then
  reason="secrets and variables are set by a person."
elif has 'gh[[:space:]]+api' && has '(-X|--method)[[:space:]=]*(PUT|PATCH|POST|DELETE)|[[:space:]](-f|-F|--field|--raw-field|--input)[[:space:]=]'; then
  if has 'rulesets|/protection|(^|[^a-z])orgs/|/actions/permissions|/environments|/collaborators|/hooks|/keys|/secrets|/variables'; then
    reason="rulesets, branch protection and repository or organization settings are changed by a person."
  elif has '(-X|--method)[[:space:]=]*(PUT|PATCH|DELETE)' && has 'repos/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+([^/A-Za-z0-9._-]|$)'; then
    reason="repository settings are changed by a person."
  fi
fi

if [ -z "$reason" ]; then
  [ "$mode" = "cursor" ] && echo '{"permission":"allow"}'
  exit 0
fi

msg="Refused by .githooks/agent-guard.sh: $reason Stop and hand this to a person (AGENTS.md, Git)."
echo "$msg" >&2
if [ "$mode" = "cursor" ]; then
  /usr/bin/jq -cn --arg m "$msg" '{permission: "deny", user_message: $m, agent_message: $m}'
fi
exit 2
