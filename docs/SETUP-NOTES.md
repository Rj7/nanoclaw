# NanoClaw Setup Notes (Raja's Install)

## Local Paths & Credentials

| Item | Location | Notes |
|------|----------|-------|
| NanoClaw project | `/home/raja/git/nanoclaw` | Main install |
| WhatsApp auth | `store/auth/creds.json` | Linked device credentials (gitignored) |
| Claude OAuth token | `.env` → `CLAUDE_CODE_OAUTH_TOKEN` | Generated via `claude setup-token` (gitignored) |
| X (Twitter) session | `data/x-browser-profile/` | Chrome profile with X login (gitignored) |
| X auth marker | `data/x-auth.json` | Auth status file (gitignored) |
| Substack auth | `~/.substack-mcp-plus/auth.json` | Encrypted token + key (outside repo) |
| Container image | `nanoclaw-agent:latest` | Docker image |
| Service unit | `~/.config/systemd/user/nanoclaw.service` | systemd user service |
| Mount allowlist | `~/.config/nanoclaw/mount-allowlist.json` | Agent filesystem access rules |

## Git Remotes

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `git@github.com:Rj7/nanoclaw.git` | Personal fork (push here) |
| `upstream` | `git@github.com:qwibitai/nanoclaw.git` | Upstream NanoClaw |
| `whatsapp` | `https://github.com/qwibitai/nanoclaw-whatsapp.git` | WhatsApp channel skill |

## Configuration

- **Assistant name:** Rot
- **Trigger word:** @rot
- **Main group:** "Rot" (WhatsApp solo group, no trigger required)
- **Bot phone:** 919791410818
- **Agent mount:** `/home/raja/git` (read-only for non-main groups)

## Integrations

### X (Twitter)
- Uses Playwright browser automation with headless Chrome
- Auth: one-time Chrome login, session saved in `data/x-browser-profile/`
- Tools: `x_post`, `x_like`, `x_reply`, `x_retweet`, `x_quote` (main group only)
- Re-auth: `npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/setup.ts`

### Substack
- Uses `substack-mcp-plus` MCP server (Python-based, runs inside container)
- Auth: encrypted tokens at `~/.substack-mcp-plus/` (mounted read-only into container)
- Tools: `get_post_content`, `list_published`, `list_drafts`, etc. (main group only)
- Re-auth: `substack-mcp-plus-setup`

## Service Management

```bash
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
systemctl --user status nanoclaw
tail -f logs/nanoclaw.log
```

## Rebuilding

```bash
npm run build                    # Rebuild host TypeScript
./container/build.sh             # Rebuild container image
systemctl --user restart nanoclaw  # Restart service
```

After changing container agent-runner code, also clear stale copies:
```bash
rm -rf data/sessions/*/agent-runner-src
```
