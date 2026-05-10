#!/usr/bin/env bash
# One-shot server setup for the always-on nanoclaw laptop.
#
# Phases (each idempotent — safe to re-run):
#   1. ensure_apt_unlocked   — wait for / kill stuck apt+dpkg locks
#   2. disable_sleep         — mask suspend/sleep/hibernate, ignore lid close
#   3. install_tailscale     — apt install + tailscale up (prints auth URL)
#   4. install_disk_cleanup  — daily docker prune + journalctl cap cron
#   5. install_health_check  — tools/health-check.sh + helper command
#
# Usage:
#   ./tools/server-setup.sh                 # run all phases
#   ./tools/server-setup.sh disable_sleep   # run one phase by name
#
# Anything needing sudo will prompt once and reuse credentials.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# ────────────────────────────────────────────────────────────
# Shared helpers
# ────────────────────────────────────────────────────────────

step() { echo ""; echo "=== $* ==="; }

# Wait for ALL apt/dpkg locks to clear. unattended-upgrades is doing real
# work; processes >1h old are treated as wedged and killed.
ensure_apt_unlocked() {
  local locks=(/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock)
  local timeout=900   # 15 min wait cap
  local elapsed=0

  while true; do
    local all_pids=""
    for lock in "${locks[@]}"; do
      [ -e "$lock" ] || continue
      local p
      p=$(sudo fuser "$lock" 2>/dev/null | tr -s ' ' || true)
      [ -n "$p" ] && all_pids="$all_pids $p"
    done
    all_pids=$(echo "$all_pids" | tr ' ' '\n' | sort -un | tr '\n' ' ')
    all_pids="${all_pids% }"

    [ -z "$all_pids" ] && return 0

    # Kill anything wedged for >1h (clearly stuck, not real work)
    local killed_any=0
    for pid in $all_pids; do
      [ -d "/proc/$pid" ] || continue
      local age cmd
      age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0)
      cmd=$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ' || echo unknown)
      if [ -n "$age" ] && [ "$age" -gt 3600 ]; then
        echo "  PID $pid ($cmd) wedged for ${age}s — killing"
        local ppid
        ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || echo 0)
        sudo kill -9 "$pid" 2>/dev/null || true
        [ "$ppid" -gt 1 ] && sudo kill -9 "$ppid" 2>/dev/null || true
        killed_any=1
      fi
    done

    if [ "$killed_any" -eq 1 ]; then
      sleep 2
      # Clean stale lock files from killed processes
      for lock in "${locks[@]}"; do
        sudo fuser "$lock" >/dev/null 2>&1 || sudo rm -f "$lock"
      done
      continue
    fi

    [ "$elapsed" -ge "$timeout" ] && { echo "Lock still held after ${timeout}s — giving up"; exit 1; }
    if [ "$((elapsed % 30))" -eq 0 ]; then
      echo "  apt lock held by:$all_pids — waiting (${elapsed}s / ${timeout}s)"
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
}

# ────────────────────────────────────────────────────────────
# Phases
# ────────────────────────────────────────────────────────────

disable_sleep() {
  step "Disable sleep, hibernate, and lid-close suspend"

  # Mask all sleep targets so nothing in userspace can request suspend
  sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

  # Configure logind to ignore lid-close in all power scenarios
  local conf=/etc/systemd/logind.conf
  sudo cp "$conf" "${conf}.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  sudo sed -i \
    -e 's/^#\?HandleLidSwitch=.*/HandleLidSwitch=ignore/' \
    -e 's/^#\?HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' \
    -e 's/^#\?HandleLidSwitchDocked=.*/HandleLidSwitchDocked=ignore/' \
    "$conf"
  # If the keys weren't present at all, append them
  grep -q '^HandleLidSwitch=' "$conf" || echo 'HandleLidSwitch=ignore' | sudo tee -a "$conf" >/dev/null
  grep -q '^HandleLidSwitchExternalPower=' "$conf" || echo 'HandleLidSwitchExternalPower=ignore' | sudo tee -a "$conf" >/dev/null
  grep -q '^HandleLidSwitchDocked=' "$conf" || echo 'HandleLidSwitchDocked=ignore' | sudo tee -a "$conf" >/dev/null
  # NOTE: do NOT `systemctl restart systemd-logind` here — it kills the
  # active GUI session. The new config loads on next reboot, which is
  # sufficient for an unattended server. If you want it sooner without
  # logging out, send SIGHUP to logind: sudo kill -HUP $(pidof systemd-logind)

  # GNOME power settings (best-effort — may not exist on a server-style desktop)
  gsettings set org.gnome.desktop.session idle-delay 0 2>/dev/null || true
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' 2>/dev/null || true
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing' 2>/dev/null || true

  echo "Sleep masked. Lid close → ignore. logind restarted."
}

install_tailscale() {
  step "Install + auth Tailscale"

  if command -v tailscale >/dev/null; then
    echo "tailscale already installed: $(tailscale version | head -1)"
  else
    . /etc/os-release
    local codename="${VERSION_CODENAME:-noble}"

    echo "Adding Tailscale apt repo for Ubuntu $codename..."
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${codename}.noarmor.gpg" \
      | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
    curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${codename}.tailscale-keyring.list" \
      | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null

    ensure_apt_unlocked
    sudo apt update -qq
    ensure_apt_unlocked
    sudo apt install -y tailscale
  fi

  sudo systemctl enable --now tailscaled

  if tailscale status >/dev/null 2>&1; then
    echo "Tailscale already authenticated."
  else
    echo "Open the URL below in any browser to authenticate this machine:"
    echo
    sudo tailscale up --ssh
  fi

  echo
  echo "  Tailscale IP: $(tailscale ip -4 2>/dev/null || echo '(re-run after auth)')"
  echo "  Hostname:     $(hostname)"
}

install_disk_cleanup() {
  step "Disk cleanup cron"

  # journalctl: cap persistent journal to 500M total
  sudo mkdir -p /etc/systemd/journald.conf.d
  sudo tee /etc/systemd/journald.conf.d/99-cap-size.conf >/dev/null <<'EOF'
[Journal]
SystemMaxUse=500M
SystemKeepFree=1G
EOF
  sudo systemctl restart systemd-journald

  # Daily cron: docker image prune + log rotation in nanoclaw logs/
  local cleanup="/home/raja/git/nanoclaw/tools/disk-cleanup.sh"
  cat > "$cleanup" <<'EOF'
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
EOF
  chmod +x "$cleanup"

  # Register in user crontab (idempotent)
  ( crontab -l 2>/dev/null | grep -v 'tools/disk-cleanup.sh'; echo "0 4 * * * $cleanup >> /home/raja/git/nanoclaw/logs/disk-cleanup.log 2>&1" ) | crontab -

  echo "Journal capped to 500M. Daily cleanup at 04:00 → tools/disk-cleanup.sh"
}

install_health_check() {
  step "Health check script"

  cat > /home/raja/git/nanoclaw/tools/health-check.sh <<'EOF'
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
EOF
  chmod +x /home/raja/git/nanoclaw/tools/health-check.sh
  echo "Wrote tools/health-check.sh"
  echo
  echo "Try it now:"
  /home/raja/git/nanoclaw/tools/health-check.sh
}

# ────────────────────────────────────────────────────────────
# Entrypoint
# ────────────────────────────────────────────────────────────

if [ "$#" -gt 0 ]; then
  for phase in "$@"; do "$phase"; done
else
  # Order matters: do all non-apt work first so the user gets value
  # even while unattended-upgrades is still holding the dpkg lock.
  # install_tailscale waits for apt internally.
  disable_sleep
  install_disk_cleanup
  install_health_check
  install_tailscale
fi

echo
echo "✓ server-setup.sh complete"
echo
echo "Still pending (manual):"
echo "  • BIOS: AC Power Recovery → Power On (next reboot)"
echo "  • Pair phone: tmux attach -t claude-nanoclaw, then /remote-control"
echo "  • Decide on FDE / disk encryption story"
