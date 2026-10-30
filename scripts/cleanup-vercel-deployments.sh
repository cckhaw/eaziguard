#!/usr/bin/env bash
# Deletes every Vercel deployment (Preview and Production) of the project that is older than
# the live production deployment. "Live" means the newest production deployment that is READY:
# skipped or failed builds (state CANCELED / ERROR) are recorded by Vercel as production
# deployments too, but they are not serving traffic.
#
# Required env: VERCEL_TOKEN, VERCEL_PROJECT_ID
# Optional env: VERCEL_TEAM_ID, DRY_RUN=true, VERCEL_API,
#               WAIT_FOR_SHA (wait until the production deployment of this git commit is READY),
#               WAIT_SECONDS (max wait, default 900), POLL_SECONDS (default 20)
# Safety rules:
#   - nothing is deleted unless a READY production deployment exists (and, with WAIT_FOR_SHA, is the one for that commit);
#   - the current production deployment and anything newer or still building is kept;
#   - a failed delete is reported and the run exits non-zero after trying the rest.
set -euo pipefail

: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"
API="${VERCEL_API:-https://api.vercel.com}"
DRY_RUN="${DRY_RUN:-false}"
TEAM_QS=""
[[ -n "${VERCEL_TEAM_ID:-}" ]] && TEAM_QS="teamId=${VERCEL_TEAM_ID}"

api() { # method path [query-string-without-leading-?]
  local method="$1" path="$2" qs="${3:-}"
  local full="${qs:+$qs&}$TEAM_QS"
  curl -fsS --retry 3 --retry-delay 2 -X "$method" \
    -H "Authorization: Bearer ${VERCEL_TOKEN}" "${API}${path}${full:+?$full}"
}

WAIT_FOR_SHA="${WAIT_FOR_SHA:-}"
WAIT_SECONDS="${WAIT_SECONDS:-900}"
POLL_SECONDS="${POLL_SECONDS:-20}"
deadline=$((SECONDS + WAIT_SECONDS))

# Wait (when asked) for the production deployment of WAIT_FOR_SHA to become READY.
while :; do
  live="$(api GET "/v6/deployments" "projectId=${VERCEL_PROJECT_ID}&target=production&state=READY&limit=1" \
    | jq -c '.deployments[0] // empty')"
  if [[ -z "$live" ]]; then
    if [[ -z "$WAIT_FOR_SHA" ]]; then
      echo "No READY production deployment exists; refusing to delete anything."
      exit 0
    fi
    current_id=""; current_created=0; sha=""
  else
    current_id="$(jq -r '.uid' <<<"$live")"
    current_created="$(jq -r '.created' <<<"$live")"
    sha="$(jq -r '.meta.githubCommitSha // empty' <<<"$live")"
    if [[ -z "$WAIT_FOR_SHA" || "$sha" == "$WAIT_FOR_SHA" ]]; then
      break
    fi
  fi
  if (( SECONDS >= deadline )); then
    echo "Timed out after ${WAIT_SECONDS}s: live production is ${current_id:-none} (commit ${sha:-unknown}), wanted a READY deployment of ${WAIT_FOR_SHA}." >&2
    exit 1
  fi
  echo "Waiting for a READY production deployment of ${WAIT_FOR_SHA:0:7} (live: ${current_id:-none}, commit ${sha:0:7})..."
  sleep "$POLL_SECONDS"
done
echo "Live production deployment: ${current_id} (commit ${sha:0:7}, created ${current_created})"

victims=()
until_ts=""
while :; do
  page="$(api GET "/v6/deployments" "projectId=${VERCEL_PROJECT_ID}&limit=100${until_ts:+&until=$until_ts}")"
  while IFS= read -r uid; do
    [[ -n "$uid" ]] && victims+=("$uid")
  done < <(jq -r --arg cur "$current_id" --argjson created "$current_created" '
      .deployments[]
      | select(.uid != $cur and .created < $created and (.state // .readyState) as $s
               | ($s == "READY" or $s == "ERROR" or $s == "CANCELED"))
      | .uid' <<<"$page")
  until_ts="$(jq -r '.pagination.next // empty' <<<"$page")"
  [[ -z "$until_ts" ]] && break
done

echo "Deployments to delete: ${#victims[@]}"
failed=0
for uid in "${victims[@]}"; do
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[dry run] would delete ${uid}"
  elif api DELETE "/v13/deployments/${uid}" >/dev/null; then
    echo "deleted ${uid}"
  else
    echo "::warning::failed to delete ${uid}"
    failed=$((failed + 1))
  fi
done
[[ "$failed" -eq 0 ]] || { echo "${failed} deletion(s) failed" >&2; exit 1; }
