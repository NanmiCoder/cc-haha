#!/usr/bin/env bash
set -euo pipefail

# Public-network acceptance is intentionally separate from deterministic check:android.
# Runtime JSON is copied directly into the disposable emulator app's private files.
if [[ $# -ne 3 ]]; then
  echo 'Usage: run-live-acceptance.sh emulator-SERIAL PHASE /absolute/runtime-config.json' >&2
  exit 2
fi
serial=$1
phase=$2
config=$3
if [[ ! $serial =~ ^emulator-[0-9]+$ || $config != /* || ! -f $config ]]; then
  echo 'An explicitly selected disposable emulator and absolute config file are required.' >&2
  exit 2
fi
case "$phase" in
  enroll) method=enroll ;;
  resume) method=resumeAfterForceStop ;;
  rotate) method=discoverRotatedOrigin ;;
  network) method=offlineThenOnline ;;
  webview) method=realWebViewLoadsAuthenticatedH5 ;;
  revoked) method=revokedDeviceRequiresPairing ;;
  cleanup) method=cleanup ;;
  *) echo 'Unknown phase; use enroll, resume, rotate, network, webview, revoked, cleanup.' >&2; exit 2 ;;
esac
adb=${ADB:-adb}
"$adb" -s "$serial" shell am force-stop com.cchaha.mobile
"$adb" -s "$serial" shell "run-as com.cchaha.mobile sh -c 'umask 077; mkdir -p files; cat > files/live-remote-acceptance.json'" < "$config"
args=(-w -r -e class "com.cchaha.mobile.LiveRemoteAcceptanceTest#$method" -e liveRemoteAcceptance disposable-emulator)
if [[ $phase == network ]]; then args+=(-e liveRemoteNetworkToggle yes); fi
report=$(mktemp "${TMPDIR:-/tmp}/cc-haha-live-android.XXXXXX")
trap 'rm -f "$report"' EXIT
"$adb" -s "$serial" shell am instrument "${args[@]}" com.cchaha.mobile.test/androidx.test.runner.AndroidJUnitRunner | tee "$report"
# am instrument can exit zero even when JUnit fails. Require the one selected test to pass.
if ! grep -Fq 'OK (1 test)' "$report" || ! grep -Fq 'INSTRUMENTATION_STATUS_CODE: 0' "$report"; then
  echo 'The selected acceptance phase did not pass; inspect the instrumentation report.' >&2
  exit 1
fi
