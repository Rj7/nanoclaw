#!/usr/bin/env bash
# Snapshot nanoclaw runtime state into ~/git/nanoclaw-state and push to GitHub.
#
# Curated subset only — see ~/git/nanoclaw-state/.gitignore for allowlist:
#   - store/messages.db (scheduled tasks, message history)
#   - data/cross-agent/* (portfolio_tickers.json, etc.)
#   - data/x-feed-config.yaml, data/substack-feed-config.yaml
#   - groups/*/CLAUDE.md, MEMORY.md, memory/**
#
# Excluded (must be rebuilt on a new machine):
#   - .env / data/env (secrets — keep in password manager)
#   - store/auth/ (WhatsApp pairing — re-pair on new device)
#   - data/x-*auth.json, data/substack-*auth.json (browser cookies — re-auth)
#   - data/*-browser-profile (regenerable, multi-GB)
#   - groups/*/conversations, logs, attachments (regenerable, large)
#
# Run via cron, e.g. every 30 min:
#   */30 * * * * cd ~/git/nanoclaw && tools/backup-state.sh >> logs/backup.log 2>&1

set -uo pipefail

REPO="${HOME}/git/nanoclaw"
STATE="${HOME}/git/nanoclaw-state"

[ -d "$REPO" ]  || { echo "nanoclaw repo not found: $REPO" >&2; exit 1; }
[ -d "$STATE" ] || { echo "state repo not found: $STATE" >&2; exit 1; }

# 1. messages.db — use sqlite .backup for consistent snapshot (handles WAL).
mkdir -p "$STATE/store"
sqlite3 "$REPO/store/messages.db" ".backup '$STATE/store/messages.db'" || {
  echo "sqlite backup failed; falling back to cp" >&2
  cp "$REPO/store/messages.db" "$STATE/store/messages.db"
}

# 2. data/cross-agent/ — portfolio tickers, cross-agent operational state
mkdir -p "$STATE/data/cross-agent"
rsync -a --delete "$REPO/data/cross-agent/" "$STATE/data/cross-agent/"

# 3. Feed configs
mkdir -p "$STATE/data"
[ -f "$REPO/data/x-feed-config.yaml" ]        && cp "$REPO/data/x-feed-config.yaml"        "$STATE/data/x-feed-config.yaml"
[ -f "$REPO/data/substack-feed-config.yaml" ] && cp "$REPO/data/substack-feed-config.yaml" "$STATE/data/substack-feed-config.yaml"

# 4. Per-group CLAUDE.md, MEMORY.md, memory/  (one rsync per dimension keeps it predictable)
for grp in "$REPO"/groups/*/; do
  name=$(basename "$grp")
  case "$name" in _fragments|main|global) continue ;; esac
  dst="$STATE/groups/$name"
  mkdir -p "$dst"
  [ -f "$grp/CLAUDE.md" ] && cp "$grp/CLAUDE.md" "$dst/CLAUDE.md"
  [ -f "$grp/MEMORY.md" ] && cp "$grp/MEMORY.md" "$dst/MEMORY.md"
  [ -d "$grp/memory" ]    && rsync -a --delete "$grp/memory/" "$dst/memory/"
done

# 5. Commit + push if there's anything to push
cd "$STATE"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git push -q origin main && echo "[$(date -Iseconds)] backup pushed" || echo "[$(date -Iseconds)] backup push failed" >&2
else
  echo "[$(date -Iseconds)] no changes"
fi
