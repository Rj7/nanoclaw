#!/usr/bin/env python3
"""
Generate portfolio performance analysis.
Outputs markdown report to stdout and JSON to workspace.

Usage:
    python3 /opt/portfolio/tools/analyze.py
"""
import sys
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, '/opt/portfolio')

from src.models import Trade, DailyNAV, init_db
from src.analytics.performance import PerformanceAnalytics

# Write JSON to agent workspace (writable), not the baked-in /opt/portfolio
OUTPUT_JSON = Path('/workspace/group/performance.json')


DB_PATH = '/workspace/group/portfolio.db'


def main():
    session = init_db(DB_PATH)
    trades = session.query(Trade).all()

    if not trades:
        print("No trades found in database.")
        return

    analytics = PerformanceAnalytics(trades)
    metrics = analytics.calculate_metrics()
    risk_metrics = analytics.calculate_risk_metrics()

    by_symbol = defaultdict(lambda: {'total_pnl': 0, 'count': 0, 'open': 0, 'closed': 0})
    for t in trades:
        pnl = (t.realized_pnl or 0) if t.status == 'CLOSED' else (t.unrealized_pnl or 0)
        by_symbol[t.symbol]['total_pnl'] += pnl
        by_symbol[t.symbol]['count'] += 1
        if t.status == 'OPEN':
            by_symbol[t.symbol]['open'] += 1
        else:
            by_symbol[t.symbol]['closed'] += 1

    by_week = defaultdict(lambda: {'winners': 0, 'losers': 0, 'total': 0, 'pnl': 0, 'trades': []})
    for t in analytics.closed_trades:
        if t.exit_date:
            iso = t.exit_date.isocalendar()
            week_key = f"{iso[0]}-W{iso[1]:02d}"
            by_week[week_key]['total'] += 1
            by_week[week_key]['pnl'] += (t.realized_pnl or 0)
            by_week[week_key]['trades'].append({'symbol': t.position_label(), 'pnl': t.realized_pnl or 0})
            if t.is_winner:
                by_week[week_key]['winners'] += 1
            else:
                by_week[week_key]['losers'] += 1

    latest_nav = session.query(DailyNAV).order_by(DailyNAV.report_date.desc()).first()
    nav_value = latest_nav.total_nav if latest_nav else None

    pf = metrics['profit_factor']
    analysis = {
        'generated_at': datetime.now().isoformat(),
        'total_positions': metrics['total_trades'],
        'closed_trades': metrics['closed_trades'],
        'open_trades': metrics['open_trades'],
        'realized_pnl': round(metrics['realized_pnl'], 2),
        'unrealized_pnl': round(metrics['unrealized_pnl'], 2),
        'total_pnl': round(metrics['total_pnl'], 2),
        'win_rate': round(metrics['win_rate'], 2),
        'profit_factor': round(pf, 2) if pf != float('inf') else 'inf',
        'sharpe_ratio': round(risk_metrics['sharpe_ratio'], 2),
        'sortino_ratio': round(risk_metrics['sortino_ratio'], 2),
        'max_drawdown_pct': round(risk_metrics['max_drawdown'] * 100, 2),
        'avg_hold_days': round(metrics['avg_hold_days'], 1),
    }

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_JSON, 'w') as f:
        json.dump(analysis, f, indent=2)

    sorted_symbols = sorted(by_symbol.items(), key=lambda x: x[1]['total_pnl'], reverse=True)

    md = f"""# Portfolio Performance Analysis

**Generated:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Summary

| Metric | Value |
|--------|-------|
| **Realized P&L** | ${metrics['realized_pnl']:,.2f} |
| **Unrealized P&L** | ${metrics['unrealized_pnl']:,.2f} |
| **Total P&L** | ${metrics['total_pnl']:,.2f} |
| **Total Trades** | {metrics['total_trades']} ({metrics['closed_trades']} closed, {metrics['open_trades']} open) |
| **Win Rate** | {metrics['win_rate']:.1f}% ({metrics['winners']}W / {metrics['losers']}L) |
| **Avg Winner** | ${metrics['avg_winner']:,.2f} |
| **Avg Loser** | ${metrics['avg_loser']:,.2f} |
| **Profit Factor** | {metrics['profit_factor']:.2f} |
| **Sharpe Ratio** | {risk_metrics['sharpe_ratio']:.2f} |
| **Sortino Ratio** | {risk_metrics['sortino_ratio']:.2f} |
| **Max Drawdown** | {risk_metrics['max_drawdown'] * 100:.1f}% |
| **Avg Hold Period** | {metrics['avg_hold_days']:.1f} days |
"""

    if nav_value:
        md += f"| **Latest NAV** | ${nav_value:,.2f} |\n"

    md += "\n## Positions by Ticker\n\n"
    md += "| Ticker | Total P&L | Trades | Open | Closed |\n"
    md += "|--------|-----------|--------|------|--------|\n"
    for symbol, data in sorted_symbols:
        md += f"| {symbol} | ${data['total_pnl']:,.2f} | {data['count']} | {data['open']} | {data['closed']} |\n"

    if by_week:
        md += "\n## Weekly Breakdown\n\n"
        md += "| Week | W-L | Win Rate | P&L | Cumul P&L |\n"
        md += "|------|-----|----------|-----|----------|\n"
        sorted_weeks = sorted(by_week.items())
        cum_pnl = 0
        for week, data in sorted_weeks:
            if data['total'] > 0:
                wr = data['winners'] / data['total'] * 100
                cum_pnl += data['pnl']
                md += f"| {week} | {data['winners']}W-{data['losers']}L | {wr:.0f}% | ${data['pnl']:,.2f} | ${cum_pnl:,.2f} |\n"

    md += "\n## Top Winners\n\n"
    md += "| Position | P&L | Days Held |\n"
    md += "|----------|-----|-----------|\n"
    for t in analytics.top_winners(10):
        md += f"| {t.position_label()} | ${t.realized_pnl:,.2f} | {t.days_held or '-'} |\n"

    md += "\n## Top Losers\n\n"
    md += "| Position | P&L | Days Held |\n"
    md += "|----------|-----|-----------|\n"
    for t in analytics.top_losers(10):
        md += f"| {t.position_label()} | ${t.realized_pnl:,.2f} | {t.days_held or '-'} |\n"

    print(md)


if __name__ == "__main__":
    main()
