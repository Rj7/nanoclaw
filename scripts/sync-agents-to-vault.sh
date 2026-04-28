#!/usr/bin/env bash
# Sync each registered agent's persona, long-term memory, and SDK auto-memory
# into ~/Obsidian/Vault/{Name}/context/ so all agents are visible on mobile.
#
# Source of truth stays in the repo / data dir. This is a one-way mirror —
# anything edited under the vault path will be overwritten on next run.
#
# Replaces the per-agent cron lines that previously hard-coded Rot and Neo;
# now picks up every row in registered_groups, so future agents are
# auto-included without crontab edits.

set -u
set -o pipefail
# Don't 'set -e' — one missing source folder shouldn't block the rest.

REPO="${HOME}/git/nanoclaw"
VAULT="${HOME}/Obsidian/Vault"
DB="${REPO}/store/messages.db"

[ -f "$DB" ] || { echo "DB not found: $DB" >&2; exit 1; }
[ -d "$VAULT" ] || { echo "Vault not found: $VAULT" >&2; exit 1; }

# Always-synced shared file.
cp "${REPO}/groups/global/CLAUDE.md" "${VAULT}/shared/global-CLAUDE.md" 2>/dev/null || true

# Iterate registered groups. Tab-separated: folder<TAB>name.
# Reject names with slashes / dots so a malformed row can't escape VAULT.
sqlite3 -separator $'\t' "$DB" "SELECT folder, name FROM registered_groups WHERE name IS NOT NULL AND name != '';" |
while IFS=$'\t' read -r folder name; do
  [ -n "$folder" ] || continue
  [ -n "$name" ] || continue
  case "$name" in *[/\\]*|*..*|.*) echo "Skipping unsafe name: $name" >&2; continue ;; esac

  src_group="${REPO}/groups/${folder}"
  src_sdk_mem="${REPO}/data/sessions/${folder}/.claude/projects/-workspace-group/memory"
  dst_ctx="${VAULT}/${name}/context"
  dst_auto="${dst_ctx}/auto-memory"

  mkdir -p "$dst_ctx" "$dst_auto"

  [ -f "${src_group}/CLAUDE.md" ] && cp "${src_group}/CLAUDE.md" "${dst_ctx}/CLAUDE.md"
  [ -f "${src_group}/MEMORY.md" ] && cp "${src_group}/MEMORY.md" "${dst_ctx}/MEMORY.md"
  [ -d "$src_sdk_mem" ] && rsync -a --delete "${src_sdk_mem}/" "${dst_auto}/"
done
