#!/usr/bin/env bash
# Run by .github/workflows/agent-watch.yml. Lists what a person reads after the fact, and fails
# when there is something to read. Needs GH_TOKEN, GITHUB_REPOSITORY, EVENT and WATCH_PATHS.
set -uo pipefail
set -f

out=${GITHUB_STEP_SUMMARY:-/dev/stdout}
read_me=0

norm='map({name, target, enforcement, bypass_actors, conditions, rules: (.rules | sort_by(.type))}) | sort_by(.name)'

{
  echo "## Rulesets"
  if ids=$(gh api "repos/$GITHUB_REPOSITORY/rulesets" --jq '.[].id'); then
    live=$(for id in $ids; do gh api "repos/$GITHUB_REPOSITORY/rulesets/$id"; done | jq -s "$norm")
    want=$(jq "$norm" .github/rulesets.json)
    # A token that cannot see bypass actors gets none back; compare them only when they are shown.
    if [ "$(jq 'all(has("bypass_actors") and .bypass_actors != null)' <<<"$live")" != "true" ]; then
      echo "Bypass actors are not visible to this token; compared without them."
      live=$(jq 'map(del(.bypass_actors))' <<<"$live")
      want=$(jq 'map(del(.bypass_actors))' <<<"$want")
    fi
    if d=$(diff <(echo "$want") <(echo "$live")); then
      echo "Same as .github/rulesets.json."
    else
      read_me=1
      echo "Differs from .github/rulesets.json (< file, > live):"
      echo '```diff'
      echo "$d"
      echo '```'
    fi
  else
    read_me=1
    echo "Could not read the rulesets."
  fi

  echo "## Merge settings"
  settings=$(gh api "repos/$GITHUB_REPOSITORY" --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge}')
  if [ "$(jq 'all(.[]; . == null)' <<<"$settings")" = "true" ]; then
    echo "Not visible to this token."
  elif [ "$(jq -cS . <<<"$settings")" = '{"allow_merge_commit":false,"allow_rebase_merge":false,"allow_squash_merge":true,"delete_branch_on_merge":true}' ]; then
    echo "Squash only, branches deleted on merge."
  else
    read_me=1
    echo '```json'
    echo "$settings"
    echo '```'
  fi

  if [ "$EVENT" != "pull_request" ]; then
    since=$(date -u -d '8 days ago' +%Y-%m-%dT%H:%M:%SZ)
    echo "## Changes to agent limits on main since $since"
    # WATCH_PATHS is split on spaces and its globs are left to git (set -f).
    # shellcheck disable=SC2086
    log=$(git log origin/main --since="$since" --format='- %h %ad %s' --date=short -- $WATCH_PATHS)
    if [ -n "$log" ]; then
      read_me=1
      echo "$log"
    else
      echo "None."
    fi
  fi
} >>"$out"

exit $read_me
