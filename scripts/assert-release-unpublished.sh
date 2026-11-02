#!/usr/bin/env bash
# Refuse to write release assets over a GitHub release that is already public.
# softprops/action-gh-release deletes and re-uploads same-name assets on an
# existing release, so a second run against a published tag would briefly
# serve missing installers and installers whose sha512 no longer matches the
# latest*.yml that running clients already downloaded.
#
# Usage: assert-release-unpublished.sh <version>   (requires GH_TOKEN and GITHUB_REPOSITORY)
set -euo pipefail

version="${1:?usage: assert-release-unpublished.sh <version>}"
error_file="$(mktemp)"
trap 'rm -f "$error_file"' EXIT

set +e
release_state=$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/v${version}" --jq '.draft' 2>"$error_file")
status=$?
set -e

if [ "$status" -ne 0 ]; then
  if grep -q 'HTTP 404' "$error_file"; then
    exit 0
  fi
  cat "$error_file" >&2
  exit "$status"
fi

if [ "$release_state" = "false" ]; then
  echo "::error::Refusing to overwrite published release v${version}. It was already published, most likely by the tag-push run; delete the release first if it really must be rebuilt."
  exit 1
fi
