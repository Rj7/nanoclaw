#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Stage portfolio source if available (external repo, not checked into nanoclaw)
PORTFOLIO_SRC="${PORTFOLIO_REPO:-$HOME/git/portfolio/trading_journal}"
STAGING_DIR="$SCRIPT_DIR/_portfolio-src"

# Ensure staging dir is cleaned up even on failure
cleanup() { rm -rf "$STAGING_DIR"; }
trap cleanup EXIT

rm -rf "$STAGING_DIR"

if [ -d "$PORTFOLIO_SRC/src" ]; then
    echo "Staging portfolio source from $PORTFOLIO_SRC..."
    mkdir -p "$STAGING_DIR/src" "$STAGING_DIR/scripts"
    cp -r "$PORTFOLIO_SRC/src/"* "$STAGING_DIR/src/"
    cp -r "$PORTFOLIO_SRC/scripts/"* "$STAGING_DIR/scripts/"
    cp "$PORTFOLIO_SRC/config.yaml" "$STAGING_DIR/" 2>/dev/null || true

    # Copy wrapper tools from container/portfolio/
    if [ -d "$SCRIPT_DIR/portfolio" ]; then
        mkdir -p "$STAGING_DIR/tools"
        cp "$SCRIPT_DIR/portfolio/"*.py "$STAGING_DIR/tools/"
        cp "$SCRIPT_DIR/portfolio/requirements.txt" "$STAGING_DIR/tools/"
    fi
    echo "Portfolio source staged successfully"
else
    echo "Portfolio source not found at $PORTFOLIO_SRC — building without portfolio tools"
    # Create empty staging dir so COPY doesn't fail
    mkdir -p "$STAGING_DIR"
    touch "$STAGING_DIR/.empty"
fi

echo ""
echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
