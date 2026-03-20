#!/usr/bin/env python3
"""
Filter trades worth reviewing — open positions, big wins, big losses.
Outputs markdown for LLM analysis.

Usage:
    python3 /opt/portfolio/tools/review.py
"""
import sys
from datetime import datetime

sys.path.insert(0, '/opt/portfolio')

from src.models import Trade, init_db

BIG_WIN_THRESHOLD = 500
BIG_LOSS_THRESHOLD = -300


def main():
    session = init_db()
    trades = session.query(Trade).all()

    if not trades:
        print("No trades found in database.")
        sys.exit(1)

    open_positions = [t for t in trades if t.status == 'OPEN']
    big_wins = [t for t in trades if t.status == 'CLOSED' and (t.realized_pnl or 0) >= BIG_WIN_THRESHOLD]
    big_losses = [t for t in trades if t.status == 'CLOSED' and (t.realized_pnl or 0) <= BIG_LOSS_THRESHOLD]

    big_wins.sort(key=lambda t: t.realized_pnl or 0, reverse=True)
    big_losses.sort(key=lambda t: t.realized_pnl or 0)
    open_positions.sort(key=lambda t: t.unrealized_pnl or 0, reverse=True)

    md = f"""# Trades Worth Reviewing

**Last Updated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Open Positions ({len(open_positions)} trades)

| Symbol | Option | Strike | Exp | Unrealized P&L | Entry Date | Days Held |
|--------|--------|--------|-----|----------------|------------|-----------|
"""

    for t in open_positions:
        pnl = t.unrealized_pnl or 0
        entry = t.entry_date.strftime('%Y-%m-%d') if t.entry_date else 'N/A'
        exp = t.expiration.strftime('%Y-%m-%d') if t.expiration else 'N/A'
        md += f"| {t.symbol} | {t.option_type} | ${t.strike:.0f} | {exp} | ${pnl:,.2f} | {entry} | {t.days_held or ''} |\n"

    md += f"""
## Big Wins ({len(big_wins)} trades >= ${BIG_WIN_THRESHOLD})

| Symbol | Option | Strike | P&L | Entry Date | Exit Date | Days Held |
|--------|--------|--------|-----|------------|-----------|-----------|
"""

    for t in big_wins[:15]:
        entry = t.entry_date.strftime('%Y-%m-%d') if t.entry_date else 'N/A'
        exit_d = t.exit_date.strftime('%Y-%m-%d') if t.exit_date else 'N/A'
        md += f"| {t.symbol} | {t.option_type} | ${t.strike:.0f} | ${t.realized_pnl:,.2f} | {entry} | {exit_d} | {t.days_held or ''} |\n"

    md += f"""
## Big Losses ({len(big_losses)} trades <= ${BIG_LOSS_THRESHOLD})

| Symbol | Option | Strike | P&L | Entry Date | Exit Date | Days Held |
|--------|--------|--------|-----|------------|-----------|-----------|
"""

    for t in big_losses[:15]:
        entry = t.entry_date.strftime('%Y-%m-%d') if t.entry_date else 'N/A'
        exit_d = t.exit_date.strftime('%Y-%m-%d') if t.exit_date else 'N/A'
        md += f"| {t.symbol} | {t.option_type} | ${t.strike:.0f} | ${t.realized_pnl:,.2f} | {entry} | {exit_d} | {t.days_held or ''} |\n"

    print(md)


if __name__ == "__main__":
    main()
