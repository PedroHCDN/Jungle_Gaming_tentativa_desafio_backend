import {
  type DbSession,
  StaleWalletError,
  type WalletRepository,
} from '../../../application/ports/persistence';
import { Wallet } from '../../../domain/wallet/wallet';
import { amount, integer, type Row, text, timestamp } from '../row-parsers';

const COLUMNS =
  'id, player_id, currency, balance, version, created_at, updated_at';

function toWallet(row: Row): Wallet {
  const currency = text(row, 'currency');
  return Wallet.rehydrate({
    id: text(row, 'id'),
    playerId: text(row, 'player_id'),
    currency,
    balance: { amount: amount(row, 'balance'), currency },
    version: integer(row, 'version'),
    createdAt: timestamp(row, 'created_at'),
    updatedAt: timestamp(row, 'updated_at'),
  });
}

export class SqlWalletRepository implements WalletRepository {
  async insert(db: DbSession, wallet: Wallet): Promise<void> {
    await db.query(
      `INSERT INTO wallets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toString(),
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
  }

  async findById(db: DbSession, id: string): Promise<Wallet | undefined> {
    const rows = await db.query<Row>(
      `SELECT ${COLUMNS} FROM wallets WHERE id = ?`,
      [id],
    );
    return rows[0] === undefined ? undefined : toWallet(rows[0]);
  }

  /**
   * Trava a linha com `FOR NO KEY UPDATE`, não `FOR UPDATE`. Os dois
   * serializam escritores (conflitam consigo mesmos), mas `FOR UPDATE`
   * também conflita com o `FOR KEY SHARE` que o INSERT de uma transação
   * filha (FK -> wallets) toma na linha: duas transações que inserem a
   * `wager_transaction` e depois pedem `FOR UPDATE` entram em deadlock
   * (40P01). `UPDATE wallets` já usa `NO KEY UPDATE`, pois não altera
   * colunas de chave, então este é o modo coerente.
   */
  async findByIdForUpdate(
    db: DbSession,
    id: string,
  ): Promise<Wallet | undefined> {
    const rows = await db.query<Row>(
      `SELECT ${COLUMNS} FROM wallets WHERE id = ? FOR NO KEY UPDATE`,
      [id],
    );
    return rows[0] === undefined ? undefined : toWallet(rows[0]);
  }

  async saveMovement(db: DbSession, wallet: Wallet): Promise<void> {
    const updated = await db.query<Row>(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?
        RETURNING id`,
      [
        wallet.balance.toString(),
        wallet.version,
        wallet.updatedAt,
        wallet.id,
        wallet.version - 1,
      ],
    );
    if (updated.length === 0) {
      throw new StaleWalletError(wallet.id);
    }
  }
}
