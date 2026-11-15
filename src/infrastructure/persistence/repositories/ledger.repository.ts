import {
  type DbSession,
  type LedgerRepository,
} from '../../../application/ports/persistence';
import { LedgerDirection } from '../../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { amount, enumValue, type Row, text, timestamp } from '../row-parsers';

const COLUMNS =
  'id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at';

function toEntry(row: Row): WalletLedgerEntry {
  const currency = text(row, 'currency');
  return WalletLedgerEntry.rehydrate({
    id: text(row, 'id'),
    walletId: text(row, 'wallet_id'),
    transactionId: text(row, 'transaction_id'),
    direction: enumValue(LedgerDirection, row, 'direction'),
    money: { amount: amount(row, 'amount'), currency },
    balanceBefore: { amount: amount(row, 'balance_before'), currency },
    balanceAfter: { amount: amount(row, 'balance_after'), currency },
    createdAt: timestamp(row, 'created_at'),
  });
}

export class SqlLedgerRepository implements LedgerRepository {
  async append(db: DbSession, entry: WalletLedgerEntry): Promise<void> {
    await db.query(
      `INSERT INTO wallet_ledger_entries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.createdAt,
      ],
    );
  }

  async findByWalletId(
    db: DbSession,
    walletId: string,
  ): Promise<WalletLedgerEntry[]> {
    const rows = await db.query<Row>(
      `SELECT ${COLUMNS} FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq`,
      [walletId],
    );
    return rows.map(toEntry);
  }

  async findByTransactionId(
    db: DbSession,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined> {
    const rows = await db.query<Row>(
      `SELECT ${COLUMNS} FROM wallet_ledger_entries WHERE transaction_id = ?`,
      [transactionId],
    );
    return rows[0] === undefined ? undefined : toEntry(rows[0]);
  }
}
