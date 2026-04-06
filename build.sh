#!/bin/bash
# Build script for Enhancivity Chrome Extension
# Usage: ./build.sh [dev|prod]
# - dev (default): API_BASE = http://localhost:3001
# - prod: API_BASE = https://service.enhancivity.com

set -e

ENV=${1:-dev}
DIST_DIR="dist"

if [ "$ENV" = "prod" ]; then
  API_BASE="https://service.enhancivity.com"
  echo "Building for PRODUCTION (API: $API_BASE)"
else
  API_BASE="http://localhost:3001"
  echo "Building for DEVELOPMENT (API: $API_BASE)"
fi

# Clean and create dist directory
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Copy all extension files (excluding dev/test files)
cp -r *.js *.css *.html *.json images popup data "$DIST_DIR/" 2>/dev/null || true

# Copy sidepanel files
cp sidepanel.* "$DIST_DIR/" 2>/dev/null || true

# Remove test/dev files from dist
rm -rf "$DIST_DIR/node_modules" \
       "$DIST_DIR/tests" \
       "$DIST_DIR/test-results" \
       "$DIST_DIR/playwright-report" \
       "$DIST_DIR/playwright.config.js" \
       "$DIST_DIR/package.json" \
       "$DIST_DIR/package-lock.json" \
       "$DIST_DIR/GEMINI.md" \
       "$DIST_DIR/docs" 2>/dev/null || true

# Replace API_BASE in background.js
sed -i "s|const API_BASE = '.*';|const API_BASE = '${API_BASE}';|" "$DIST_DIR/background.js"

echo ""
echo "Build complete: ./$DIST_DIR/"
echo "API_BASE set to: $API_BASE"
echo ""
echo "To load in Chrome:"
echo "1. Go to chrome://extensions"
echo "2. Enable Developer Mode"
echo "3. Click 'Load unpacked' and select the '$DIST_DIR' folder"
