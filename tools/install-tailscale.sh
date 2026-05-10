#!/usr/bin/env bash
# Install Tailscale on Ubuntu and bring it up. Idempotent.
#
# After it runs, an auth URL prints to stdout — open it in any browser
# to log into your Tailscale account. The machine then gets a stable
# 100.x.x.x address reachable from your phone (Tailscale app on same
# account) and from any other device you've added to your tailnet.
#
# Usage:  ./tools/install-tailscale.sh

set -euo pipefail

# Clear stuck apt locks. The daily auto-update timer (apt.systemd.daily)
# can get wedged for weeks, holding /var/lib/apt/lists/lock and blocking
# any other apt command. If a process has been holding it for >1h, we
# treat it as dead and kill it.
ensure_apt_unlocked() {
  local lock=/var/lib/apt/lists/lock
  local pids
  pids=$(sudo fuser "$lock" 2>/dev/null | tr -s ' ' || true)
  [ -z "$pids" ] && return 0

  echo "apt lock held by:$pids"
  for pid in $pids; do
    [ -d "/proc/$pid" ] || continue
    # Process age in seconds (etimes reported by ps)
    local age
    age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -n "$age" ] && [ "$age" -gt 3600 ]; then
      echo "  PID $pid running ${age}s — killing as stuck"
      sudo kill -9 "$pid" 2>/dev/null || true
      # Walk the parent chain too — apt.systemd.daily wraps apt-get
      local ppid
      ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
      [ -n "$ppid" ] && [ "$ppid" -gt 1 ] && sudo kill -9 "$ppid" 2>/dev/null || true
    else
      echo "  PID $pid running ${age:-?}s — waiting up to 5min"
      local waited=0
      while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 300 ]; do
        sleep 5
        waited=$((waited + 5))
      done
      kill -0 "$pid" 2>/dev/null && { echo "still locked, giving up"; exit 1; }
    fi
  done

  # Stale lock files left behind by killed processes
  sleep 1
  sudo fuser "$lock" >/dev/null 2>&1 || sudo rm -f "$lock" /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock
}

if command -v tailscale >/dev/null; then
  echo "tailscale already installed: $(tailscale version | head -1)"
else
  . /etc/os-release
  CODENAME="${VERSION_CODENAME:-noble}"

  echo "Adding Tailscale apt repo for Ubuntu $CODENAME..."
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${CODENAME}.noarmor.gpg" \
    | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${CODENAME}.tailscale-keyring.list" \
    | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null

  echo "Installing tailscale..."
  ensure_apt_unlocked
  sudo apt update -qq
  ensure_apt_unlocked
  sudo apt install -y tailscale
fi

# Ensure daemon is enabled + running across reboots
sudo systemctl enable --now tailscaled

# Bring it up. If already authed, this is a no-op; otherwise it prints
# an auth URL you open in a browser to register this machine.
if tailscale status >/dev/null 2>&1; then
  echo ""
  echo "Tailscale already authenticated."
else
  echo ""
  echo "Authenticating — open the URL below in any browser to log in:"
  echo ""
  sudo tailscale up
fi

echo ""
echo "============================================"
echo "Tailscale IP: $(tailscale ip -4 2>/dev/null || echo '(not yet — re-run after auth)')"
echo "Hostname:     $(tailscale status --self --json 2>/dev/null | grep -oP '"DNSName":\s*"\K[^"]+' | head -1 || hostname)"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Install Tailscale on your phone, log in to the same account"
echo "  2. SSH from phone:  ssh raja@<the 100.x.x.x address above>"
echo "  3. Optional — enable Tailscale SSH so you don't need a key on your phone:"
echo "       sudo tailscale up --ssh"
