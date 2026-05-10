#!/usr/bin/env bash
# Quick health summary for the nanoclaw server. SSH in from phone:
#   ssh raja@<tailscale-ip> ~/git/nanoclaw/tools/health-check.sh
set -uo pipefail

echo "==== nanoclaw health $(date -Iseconds) ===="
echo
echo "Uptime:"
uptime
echo

echo "Disk:"
df -h / /home 2>/dev/null | grep -v tmpfs
echo

echo "Memory:"
free -h | head -2
echo

echo "Services (user):"
for svc in nanoclaw nanoclaw-x-feed nanoclaw-substack-feed claude-nanoclaw; do
  state=$(systemctl --user is-active "$svc" 2>/dev/null)
  printf "  %-30s %s\n" "$svc" "$state"
done
echo

echo "Tmux sessions:"
tmux ls 2>/dev/null || echo "  (none)"
echo

if command -v tailscale >/dev/null; then
  echo "Tailscale:"
  echo "  IP:       $(tailscale ip -4 2>/dev/null || echo '(not connected)')"
  echo "  Status:   $(tailscale status --self 2>/dev/null | head -1 || echo '(unknown)')"
  echo
fi

echo "Recent backup runs:"
tail -5 /home/raja/git/nanoclaw/logs/backup.log 2>/dev/null || echo "  (no log yet)"
echo

echo "Last 5 nanoclaw errors:"
journalctl --user -u nanoclaw --since '24h ago' -p err -n 5 --no-pager 2>/dev/null | tail -10
