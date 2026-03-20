#!/usr/bin/env python3
"""
Full IBKR portfolio sync: NAV + trades + open positions.

Downloads the Flex Query report ONCE and processes all sections from the
cached response. This avoids 3 separate round trips to IBKR (each taking
30-90 seconds).

Usage:
    python3 /opt/portfolio/tools/sync.py
    python3 /opt/portfolio/tools/sync.py --nav-only
"""
import sys
import os
import argparse

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

    try:
        from ibflex import client as ib_client, parser as ib_parser
    except ImportError:
        print("ERROR: ibflex library not installed")
        sys.exit(1)

    session = init_db()
    client = FlexQueryClient(session, token=args.token, query_id=args.query_id)

    # Download the Flex Query report ONCE
    print(f"Fetching Flex Query report from IBKR (query {args.query_id})...")
    try:
        response = ib_client.download(args.token, args.query_id)
        stmt = ib_parser.parse(response)
        print("Report downloaded successfully")
    except Exception as e:
        print(f"FAILED to download report: {e}")
        sys.exit(1)

    results = {}

    # 1. Sync daily NAV (uses EquitySummaryInBase + CashTransactions)
    print("\nSyncing daily NAV...")
    try:
        nav_result = _process_nav(client, stmt)
        results['nav'] = nav_result
        if nav_result['status'] == 'success':
            print(f"  {nav_result['records_created']} new, {nav_result['records_updated']} updated, {nav_result['records_skipped']} skipped")
            if nav_result.get('accounts'):
                print(f"  Accounts: {', '.join(nav_result['accounts'])}")
            if nav_result.get('date_range', {}).get('start'):
                print(f"  Date range: {nav_result['date_range']['start']} → {nav_result['date_range']['end']}")
        else:
            print(f"  FAILED: {nav_result.get('message', 'Unknown error')}")
    except Exception as e:
        print(f"  FAILED: {e}")
        results['nav'] = {'status': 'error', 'message': str(e)}

    if not args.nav_only:
        # 2. Sync trades (uses Trades section)
        print("\nSyncing trades...")
        try:
            trades_result = _process_trades(client, stmt)
            results['trades'] = trades_result
            if trades_result.get('status') == 'success':
                created = trades_result.get('trades_created', 0)
                skipped = trades_result.get('trades_skipped', 0)
                missing = trades_result.get('missing_expiry', 0)
                print(f"  {created} created, {skipped} skipped, {missing} missing expiry")
                for w in trades_result.get('warnings', []):
                    print(f"  ⚠ {w}")
            else:
                print(f"  FAILED: {trades_result.get('message', 'Unknown error')}")
        except Exception as e:
            print(f"  FAILED: {e}")
            results['trades'] = {'status': 'error', 'message': str(e)}

        # 3. Sync open positions (uses OpenPositions section)
        print("\nSyncing open positions...")
        try:
            positions_result = _process_positions(client, stmt)
            results['positions'] = positions_result
            if positions_result.get('status') == 'success':
                created = positions_result.get('positions_created', 0)
                cleared = positions_result.get('positions_cleared', 0)
                print(f"  {created} positions loaded ({cleared} stale cleared)")
            else:
                print(f"  FAILED: {positions_result.get('message', 'Unknown error')}")
        except Exception as e:
            print(f"  FAILED: {e}")
            results['positions'] = {'status': 'error', 'message': str(e)}

    # Summary
    print("\n--- Sync Complete ---")
    has_error = any(r.get('status') == 'error' for r in results.values() if isinstance(r, dict))
    if has_error:
        print("Some components had errors (see above)")
        sys.exit(1)
    else:
        print("All components synced successfully")


def _process_nav(client: FlexQueryClient, stmt) -> dict:
    """Process NAV from an already-downloaded Flex Query statement."""
    from datetime import datetime

    stats = {
        'status': 'success',
        'records_created': 0,
        'records_updated': 0,
        'records_skipped': 0,
        'errors': [],
        'accounts': set(),
        'date_range': {'start': None, 'end': None}
    }

    for flex_stmt in stmt.FlexStatements:
        account_id = flex_stmt.accountId
        stats['accounts'].add(account_id)
        client._ensure_account(account_id)

        equity_records = getattr(flex_stmt, 'EquitySummaryInBase', []) or []
        for record in equity_records:
            try:
                result = client._process_equity_record(account_id, record)
                if result == 'created':
                    stats['records_created'] += 1
                elif result == 'updated':
                    stats['records_updated'] += 1
                else:
                    stats['records_skipped'] += 1

                if hasattr(record, 'reportDate') and record.reportDate:
                    report_date = record.reportDate
                    if isinstance(report_date, str):
                        report_date = datetime.strptime(report_date, '%Y-%m-%d').date()
                    if stats['date_range']['start'] is None or report_date < stats['date_range']['start']:
                        stats['date_range']['start'] = report_date
                    if stats['date_range']['end'] is None or report_date > stats['date_range']['end']:
                        stats['date_range']['end'] = report_date
            except Exception as e:
                stats['errors'].append(f"{account_id}: {e}")

    # Cash transactions
    for flex_stmt in stmt.FlexStatements:
        account_id = flex_stmt.accountId
        cash_transactions = getattr(flex_stmt, 'CashTransactions', []) or []
        for record in cash_transactions:
            try:
                client._process_cash_transaction(account_id, record)
            except Exception as e:
                stats['errors'].append(f"{account_id} cash: {e}")

    try:
        client.session.commit()
    except Exception as e:
        client.session.rollback()
        return {'status': 'error', 'message': f'DB commit failed: {e}'}

    stats['accounts'] = list(stats['accounts'])
    return stats


def _process_trades(client: FlexQueryClient, stmt) -> dict:
    """Process trades from an already-downloaded Flex Query statement."""
    stats = {
        'status': 'success',
        'trades_created': 0,
        'trades_skipped': 0,
        'missing_expiry': 0,
        'warnings': [],
        'errors': [],
        'accounts': set()
    }

    for flex_stmt in stmt.FlexStatements:
        account_id = flex_stmt.accountId
        stats['accounts'].add(account_id)
        account = client._ensure_account(account_id)
        trades = getattr(flex_stmt, 'Trades', []) or []

        for record in trades:
            try:
                result = client._process_trade(account, record)
                if result == 'created':
                    client.session.flush()
                    stats['trades_created'] += 1
                elif result == 'missing_expiry':
                    stats['missing_expiry'] += 1
                else:
                    stats['trades_skipped'] += 1
            except Exception as e:
                stats['errors'].append(f"{account_id}: {e}")

    try:
        client.session.commit()
    except Exception as e:
        client.session.rollback()
        return {'status': 'error', 'message': f'DB commit failed: {e}'}

    if stats['missing_expiry'] > 0:
        stats['warnings'].append(
            f"{stats['missing_expiry']} trade(s) skipped — missing expiration date"
        )

    stats['accounts'] = list(stats['accounts'])
    return stats


def _process_positions(client: FlexQueryClient, stmt) -> dict:
    """Process open positions from an already-downloaded Flex Query statement."""
    from datetime import datetime
    from src.models import OpenPosition

    stats = {
        'status': 'success',
        'positions_created': 0,
        'positions_cleared': 0,
        'errors': [],
        'accounts': set()
    }

    for flex_stmt in stmt.FlexStatements:
        account_id = flex_stmt.accountId
        stats['accounts'].add(account_id)
        client._ensure_account(account_id)

        positions = getattr(flex_stmt, 'OpenPositions', []) or []

        report_dates = set()
        for record in positions:
            rd = getattr(record, 'reportDate', None)
            if rd:
                if isinstance(rd, str):
                    rd = datetime.strptime(rd, '%Y-%m-%d').date()
                report_dates.add(rd)

        if report_dates:
            deleted = client.session.query(OpenPosition).filter(
                OpenPosition.account_id == account_id,
                OpenPosition.report_date.in_(report_dates)
            ).delete(synchronize_session=False)
            stats['positions_cleared'] += deleted

        for record in positions:
            try:
                result = client._process_open_position(account_id, record)
                if result == 'created':
                    stats['positions_created'] += 1
            except Exception as e:
                stats['errors'].append(f"{account_id}: {e}")

    try:
        client.session.commit()
    except Exception as e:
        client.session.rollback()
        return {'status': 'error', 'message': f'DB commit failed: {e}'}

    stats['accounts'] = list(stats['accounts'])
    return stats


if __name__ == '__main__':
    main()
