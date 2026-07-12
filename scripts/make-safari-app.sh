#!/usr/bin/env bash
#
# Build the Safari app wrapper for Hermes Browser Extension.
#
#   ./scripts/make-safari-app.sh [--install]
#
# Runs: npm run build:safari -> safari-web-extension-converter -> xcodebuild.
# With --install, also copies the built app to /Applications and launches it
# (launching is what registers the extension with Safari).
#
# Requires Xcode (not just the Command Line Tools).
#
# --- Why APP_NAME and BUNDLE_ID look the way they do -------------------------
# safari-web-extension-converter derives the *app* target's bundle identifier
# from the app NAME (spaces -> dashes), but names the *extension* target
# "<--bundle-identifier>.Extension". If those two disagree — including by case —
# Xcode fails with:
#
#   error: Embedded binary's bundle identifier is not prefixed with the
#          parent app's bundle identifier.
#
# So BUNDLE_ID must equal <PREFIX>.<APP_NAME with spaces replaced by dashes>,
# matching case exactly. Change APP_NAME and you must change BUNDLE_ID to match.
set -euo pipefail

APP_NAME="Hermes Browser"
BUNDLE_PREFIX="io.github.abundantbeing"
BUNDLE_ID="${BUNDLE_PREFIX}.${APP_NAME// /-}"   # -> io.github.abundantbeing.Hermes-Browser

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT_DIR="build/safari"
DERIVED="build/dd"

echo "==> 1/3  Building Safari extension payload (dist/safari)"
npm run build:safari

echo "==> 2/3  Converting to an Xcode project (${PROJECT_DIR})"
rm -rf "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR"
xcrun safari-web-extension-converter dist/safari \
  --macos-only \
  --project-location "$PROJECT_DIR" \
  --app-name "$APP_NAME" \
  --bundle-identifier "$BUNDLE_ID" \
  --swift --no-open --no-prompt --force

# The converter warns that manifest key `type` is unsupported. That warning is
# stale: Safari 16.4+ supports ES-module service workers ("type": "module").
# Our manifest floor is 16.4, so it is safe to ignore.

echo "==> 3/3  Building the app (ad-hoc signed)"
rm -rf "$DERIVED"
xcodebuild \
  -project "${PROJECT_DIR}/${APP_NAME}/${APP_NAME}.xcodeproj" \
  -scheme "$APP_NAME" \
  -configuration Release \
  -derivedDataPath "$DERIVED" \
  CODE_SIGN_IDENTITY="-" \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="" \
  CODE_SIGNING_REQUIRED=YES \
  CODE_SIGNING_ALLOWED=YES \
  build

APP_PATH="${DERIVED}/Build/Products/Release/${APP_NAME}.app"
echo
echo "Built: ${APP_PATH}"

if [[ "${1:-}" == "--install" ]]; then
  echo "==> Installing to /Applications and launching (registers the extension with Safari)"
  rm -rf "/Applications/${APP_NAME}.app"
  cp -R "$APP_PATH" /Applications/
  open "/Applications/${APP_NAME}.app"
  echo "Installed: /Applications/${APP_NAME}.app"
fi

cat <<EOF

Next — these steps are GUI-only, Safari has no CLI for them:

  1. Safari > Settings > Advanced > check "Show features for web developers"
  2. Safari menu bar > Develop > check "Allow Unsigned Extensions"
     (ad-hoc builds are unsigned; this resets every time Safari restarts.
      Sign with a Developer ID to make it stick — see SAFARI.md)
  3. Safari > Settings > Extensions > enable "Hermes Browser Extension"
  4. Grant it access to the sites you want it to read.

Then click the toolbar button (or press Alt+H) to open the Hermes panel.
EOF
