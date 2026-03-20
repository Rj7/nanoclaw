#!/usr/bin/env python3
"""
Full IBKR portfolio sync: NAV + trades + open positions.

Usage:
    python3 /opt/portfolio/tools/sync.py \
        --token "$IBKR_FLEX_QUERY_TOKEN" --query-id "$IBKR_FLEX_QUERY_ID"
"""
import sys
import os
import argparse
import json

sys.path.insert(0, '/opt/portfolio')

from src.models import init_db
from src.importers import FlexQueryClient


def main():
    parser = argparse.ArgumentParser(description="Full IBKR portfolio sync")
    parser.add_argument('--token', default=os.environ.get('IBKR_FLEX_QUERY_TOKEN'),
                        help="IBKR Flex Query token (default: $IBKR_FLEX_QUERY_TOKEN)")
    parser.add_argument('--query-id', default=os.environ.get('IBKR_FLEX_QUERY_ID'),
                        help="IBKR Flex Query ID (default: $IBKR_FLEX_QUERY_ID)")
    parser.add_argument('--nav-only', action='store_true', help="Only sync NAV data")
    args = parser.parse_args()

    if not args.token or not args.query_id:
        print("ERROR: --token and --query-id required (or set IBKR_FLEX_QUERY_TOKEN / IBKR_FLEX_QUERY_ID)")
        sys.exit(1)

    session = init_db()
    client = FlexQueryClient(session, token=args.token, query_id=args.query_id)

    results = {}

    # 1. Sync daily NAV
    print("Syncing daily NAV...")
    nav_result = client.fetch_daily_nav()
    results['nav'] = nav_result
    if nav_result['status'] == 'success':
        print(f"  NAV: {nav_result['records_created']} new, {nav_result['records_updated']} updated, {nav_result['records_skipped']} skipped")
        if nav_result.get('accounts'):
            print(f"  Accounts: {', '.join(nav_result['accounts'])}")
        if nav_result.get('date_range', {}).get('start'):
            print(f"  Date range: {nav_result['date_range']['start']} → {nav_result['date_range']['end']}")
    else:
        print(f"  NAV FAILED: {nav_result.get('message', 'Unknown error')}")

    if not args.nav_only:
        # 2. Sync trades (opens + closes)
        print("Syncing trades...")
        try:
            trades_result = client.fetch_trades()
            results['trades'] = trades_result
            if trades_result.get('status') == 'success':
                print(f"  Trades: {trades_result.get('trades_created', 0)} new, {trades_result.get('trades_closed', 0)} closed, {trades_result.get('trades_updated', 0)} updated")
            else:
                print(f"  Trades: {trades_result.get('message', 'completed')}")
        except Exception as e:
            msg = str(e)
            print(f"  Trades FAILED: {msg}")
            results['trades'] = {'status': 'error', 'message': msg}

        # 3. Sync open positions
        print("Syncing open positions...")
        try:
            positions_result = client.fetch_open_positions()
            results['positions'] = positions_result
            if positions_result.get('status') == 'success':
                print(f"  Positions: {positions_result.get('positions_count', 0)} positions across {positions_result.get('report_dates', 0)} report dates")
            else:
                print(f"  Positions: {positions_result.get('message', 'completed')}")
        except Exception as e:
            msg = str(e)
            print(f"  Positions FAILED: {msg}")
            results['positions'] = {'status': 'error', 'message': msg}

    # Summary
    print("\n--- Sync Complete ---")
    has_error = any(r.get('status') == 'error' for r in results.values() if isinstance(r, dict))
    if has_error:
        print("Some components had errors (see above)")
        sys.exit(1)
    else:
        print("All components synced successfully")


if __name__ == '__main__':
    main()
