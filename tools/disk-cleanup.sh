#!/usr/bin/env bash
# Daily disk hygiene. Safe to run any time.
set -uo pipefail

# Prune dangling Docker images + build cache (keeps tagged images)
if command -v docker >/dev/null; then
  docker system prune -f --filter 'until=72h' >/dev/null 2>&1 || true
fi

# Rotate big nanoclaw logs (keep last 7d)
find /home/raja/git/nanoclaw/logs -type f -name '*.log' -size +50M -mtime +7 -delete 2>/dev/null
find /home/raja/git/nanoclaw/groups/*/logs -type f -name '*.log' -mtime +14 -delete 2>/dev/null

# Trim apt cache
sudo -n apt-get autoclean -qq 2>/dev/null || true
