#!/usr/bin/env bash
# Every migration test, in one 1Password session:  pnpm test:migrate:all
#
# Runs each source's variations on the dev instance, then the 1K run on the
# raised-limit dev instance and the 10K run on production. A failing source
# doesn't stop the rest; the summary at the end lists each one's exit code,
# and every report is in test-results/<stamp>-<provider>-<target>/report.md.
#
# Expects to run under `op run --env-file=op.env` (the package.json script does).
set -u
cd "$(dirname "$0")/.."

# Free Supabase projects pause after a week idle; wake it before its turn.
wake_supabase() {
  local ref status
  ref=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https://([^.]+)\..*#\1#')
  for i in $(seq 1 40); do
    status=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "https://api.supabase.com/v1/projects/$ref" |
      python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))')
    [ "$status" = "ACTIVE_HEALTHY" ] && return 0
    if [ "$i" = 1 ] && [ "$status" = "INACTIVE" ]; then
      echo "Supabase project is paused; requesting a restore"
      curl -s -X POST -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" "https://api.supabase.com/v1/projects/$ref/restore" >/dev/null
    fi
    echo "Supabase status: $status (waiting)"
    sleep 15
  done
  echo "Supabase never became healthy"
  return 1
}

declare -a summary
run() {
  local label=$1; shift
  echo; echo "=== $label  $(date +%H:%M:%S)"
  tsx scripts/test-migrate.ts "$@"
  local code=$?
  summary+=("$(printf '%-24s %s' "$label" "$([ $code = 0 ] && echo pass || echo "FAIL (exit $code)")")")
}

for p in clerk auth0 authjs supabase firebase workos better-auth; do
  if [ "$p" = supabase ] && ! wake_supabase; then summary+=("$(printf '%-24s %s' supabase "SKIPPED (project not healthy)")"); continue; fi
  run "$p" -p "$p"
done
run "better-auth 1K (10k-dev)" -p better-auth -t 10k-dev -v BK1K
run "better-auth 10K (prod)" -p better-auth -t 10k-prod -v BK

echo; echo "=== Summary"
printf '%s\n' "${summary[@]}"
