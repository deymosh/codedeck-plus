#!/bin/sh
# What a Gradle task left behind in apps/android, in one line each: the counts
# from the JUnit XML, which test classes failed, and what lint said.
#
# Run from the app's directory (apps/android), on the host or inside the
# container `./codedeck android` runs tasks in — the same paths either way.
# `./codedeck android` runs it after the task, pass or fail: a failure is when
# the summary is worth most, and `exit 0` at the end keeps a missing report
# file from being read as the task failing.
#
# Written as a file rather than as a string inside the script so it can be
# read (and run) on its own, which is also what makes `sh
# scripts/lib/android-report.sh` a way to look at the last run without
# re-running Gradle.

set -e

results=app/build/test-results/testDebugUnitTest
if [ -d "$results" ]; then
  # One `find` per count, summed: the XML has one <testsuite> per test class.
  count() {
    grep -h -o "$1=\"[0-9]*\"" "$results"/*.xml 2>/dev/null | awk -F'"' '{n+=$2} END{print n+0}'
  }
  printf '==> tests: %s run, %s failed, %s errored, %s skipped\n' \
    "$(count tests)" "$(count failures)" "$(count errors)" "$(count skipped)"
  for file in "$results"/*.xml; do
    if grep -qE 'failures="[1-9]|errors="[1-9]' "$file" 2>/dev/null; then
      printf '    failed: %s\n' "$(basename "$file" .xml | sed 's/^TEST-//')"
    fi
  done
fi

lint=app/build/reports/lint-results-debug.txt
if [ -f "$lint" ]; then
  printf '==> lint: %s\n' "$(grep -Eo '[0-9]+ errors?, [0-9]+ warnings?' "$lint" | tail -1)"
fi

exit 0
