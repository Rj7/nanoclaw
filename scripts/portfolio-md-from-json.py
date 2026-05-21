#!/usr/bin/env python3
# Regenerate Vault/shared/portfolio.md from data/cross-agent/portfolio_tickers.json.
#
# Markdown is a one-way mirror of the JSON — readable on phone via Obsidian Sync.
# Source of truth stays as JSON (written by Neo on each IBKR sync).
#
# Idempotent via mtime: only re-renders when the JSON is newer than the MD.

import datetime
import json
import os
import sys

REPO = os.environ.get('NANOCLAW_REPO', os.path.expanduser('~/git/nanoclaw'))
VAULT = os.environ.get('NANOCLAW_VAULT', os.path.expanduser('~/Obsidian/Vault'))

JSON_PATH = os.path.join(REPO, 'data', 'cross-agent', 'portfolio_tickers.json')
MD_PATH = os.path.join(VAULT, 'shared', 'portfolio.md')
TICKERS_DIR = os.path.join(VAULT, 'shared', 'tickers')


def sort_key(row):
    try:
        return (0, -float(row[1]), row[0])
    except (TypeError, ValueError):
        return (1, 0.0, row[0])


def main():
    try:
        json_mtime = os.stat(JSON_PATH).st_mtime
    except FileNotFoundError:
        print(f'portfolio JSON not found: {JSON_PATH}', file=sys.stderr)
        return 1

    try:
        if os.stat(MD_PATH).st_mtime >= json_mtime:
            return 0
    except FileNotFoundError:
        pass

    with open(JSON_PATH) as f:
        portfolio = json.load(f)

    rows = []
    for pos in portfolio['positions']:
        t = pos['ticker']
        w = pos.get('weight')
        w_str = f'{w}' if w is not None else '—'
        path = os.path.join(TICKERS_DIR, f'{t}.md')
        try:
            mtime = datetime.date.fromtimestamp(os.stat(path).st_mtime).isoformat()
            link = f'[[{t}]]'
        except FileNotFoundError:
            mtime, link = '—', '— *(no page)*'
        rows.append((t, w_str, link, mtime))

    rows.sort(key=sort_key)

    lines = [
        '---',
        'title: Portfolio',
        f"date: {portfolio['updated']}",
        'type: portfolio',
        '---',
        '',
        '# Portfolio',
        '',
        f"*Auto-generated from `data/cross-agent/portfolio_tickers.json` (updated by Neo on each IBKR sync). Last sync: {portfolio['updated']}.*",
        '',
        '*Do not hand-edit this file — changes are overwritten by the next sync. To change positions, ask Neo or edit `portfolio_tickers.json` directly.*',
        '',
        '| Ticker | Weight (%) | Vault | Last vault update |',
        '|--------|-----------|-------|-------------------|',
    ]
    lines.extend(f'| {t} | {w} | {link} | {mtime} |' for t, w, link, mtime in rows)
    lines.append('')
    lines.append('*Tickers with weight `—` are tracked in a second account where size is unknown. Tickers marked `(no page)` need a `/coverage` initiation.*')
    lines.append('')

    with open(MD_PATH, 'w') as f:
        f.write('\n'.join(lines))
    print(f'portfolio.md regenerated ({len(rows)} positions)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
