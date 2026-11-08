#!/usr/bin/env bash
# Builds the agent-desktop E2E fixture into a runnable .app bundle.
# Usage: tests/fixture-app/build.sh [output-dir]
# Output: <output-dir>/AgentDeskFixture.app (default: alongside this script)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out_dir="${1:-$here/build}"
app="$out_dir/AgentDeskFixture.app"
macos_dir="$app/Contents/MacOS"
bin="$macos_dir/AgentDeskFixture"

if [ -e "$app" ]; then
  previous="$(mktemp -d "$out_dir/.fixture-previous.XXXXXX")"
  mv "$app" "$previous/"
fi
mkdir -p "$macos_dir"

# Pin the SDK and deployment target so the fixture builds reproducibly instead
# of inheriting whatever the host toolchain defaults to (matches the
# LSMinimumSystemVersion in the Info.plist below). Compile every .swift file in
# this directory as one module.
sdk="$(xcrun --show-sdk-path --sdk macosx)"
target="$(uname -m)-apple-macos13.0"
swiftc -O -parse-as-library \
  -target "$target" -sdk "$sdk" \
  -framework SwiftUI -framework AppKit \
  -o "$bin" \
  "$here"/*.swift

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>AgentDeskFixture</string>
  <key>CFBundleDisplayName</key><string>AgentDeskFixture</string>
  <key>CFBundleIdentifier</key><string>com.agentdesktop.fixture</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>AgentDeskFixture</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

if [ "${AGENT_DESKTOP_FIXTURE_BACKGROUND_BUNDLE:-}" = "1" ]; then
  /usr/bin/plutil -insert LSUIElement -bool true "$app/Contents/Info.plist"
fi

echo "Built: $app"
