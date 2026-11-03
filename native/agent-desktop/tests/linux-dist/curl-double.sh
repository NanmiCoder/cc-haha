#!/usr/bin/env bash
# A PATH-first curl stand-in for the installed-package leg.
#
# The npm postinstall downloads a release archive and checksums.txt from a
# hard-coded GitHub URL. This double serves those two files from a local
# directory and records every request, so the leg can prove the installer
# actually downloaded instead of reusing a stray binary.
#
# Environment:
#   AD_CURL_DOUBLE_DIR  directory holding files named after each URL's basename
#   AD_CURL_DOUBLE_LOG  optional file that receives one requested URL per line
#
# It accepts exactly the argv the installer passes (L22-13) and fails loudly on
# anything else, so a drifted invocation cannot pass unnoticed.
set -euo pipefail

dir=${AD_CURL_DOUBLE_DIR:?AD_CURL_DOUBLE_DIR is required}
log=${AD_CURL_DOUBLE_LOG:-}
dest=
url=

while [ $# -gt 0 ]; do
  case "$1" in
    -fsSL) shift ;;
    --retry) [ $# -ge 2 ] || { echo "curl-double: --retry needs a value" >&2; exit 2; }; shift 2 ;;
    --retry-delay) [ $# -ge 2 ] || { echo "curl-double: --retry-delay needs a value" >&2; exit 2; }; shift 2 ;;
    -o)
      [ $# -ge 2 ] || { echo "curl-double: -o needs a path" >&2; exit 2; }
      dest=$2
      shift 2
      ;;
    -*)
      echo "curl-double: refusing unknown option $1" >&2
      exit 2
      ;;
    *)
      [ -z "$url" ] || { echo "curl-double: more than one URL: $url $1" >&2; exit 2; }
      url=$1
      shift
      ;;
  esac
done

[ -n "$url" ] || { echo "curl-double: no URL asked for" >&2; exit 2; }
[ -n "$dest" ] || { echo "curl-double: no output path asked for" >&2; exit 2; }

name=${url##*/}
source="$dir/$name"
if [ ! -f "$source" ]; then
  echo "curl-double: no file serves $url (looked for $source)" >&2
  exit 22
fi

if [ -n "$log" ]; then
  printf '%s\n' "$url" >> "$log"
fi
cp "$source" "$dest"
