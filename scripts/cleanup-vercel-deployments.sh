#!/usr/bin/env bash
# Deletes every Vercel deployment (Preview and Production) of the project that is
# older than the project's current production deployment, once that deployment is READY.
#
# Required env: VERCEL_TOKEN, VERCEL_PROJECT_ID     Optional: VERCEL_TEAM_ID, DRY_RUN=true, VERCEL_API
# Safety rules:
#   - nothing is deleted unless the current production deployment is READY (live);
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

current_id="$(api GET "/v9/projects/${VERCEL_PROJECT_ID}" | jq -r '.targets.production.id // empty')"
if [[ -z "$current_id" ]]; then
  echo "Project has no production deployment; nothing to do."
  exit 0
fi

current="$(api GET "/v13/deployments/${current_id}")"
state="$(jq -r '.readyState // .status' <<<"$current")"
current_created="$(jq -r '.createdAt' <<<"$current")"
if [[ "$state" != "READY" ]]; then
  echo "Current production deployment ${current_id} is ${state}, not READY; refusing to delete anything."
  exit 0
fi
echo "Current production deployment: ${current_id} (created ${current_created}, READY)"

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
