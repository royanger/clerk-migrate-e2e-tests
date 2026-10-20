#!/usr/bin/env bash
# Temporary: prints the start time, then the end time and time elapsed, around
# a test command. package.json's test:* scripts run through it.
start=$(date +%s)
echo "Started: $(date '+%Y-%m-%d %H:%M:%S')"
# A handler, not an ignore: Ctrl-C still reaches the test, and the end prints.
trap 'true' INT
"$@"
code=$?
s=$(($(date +%s) - start))
echo "Ended:   $(date '+%Y-%m-%d %H:%M:%S')  (elapsed $((s / 3600))h $((s % 3600 / 60))m $((s % 60))s)"
exit $code
