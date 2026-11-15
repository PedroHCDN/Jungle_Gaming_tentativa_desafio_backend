import {
  type DbSession,
  TransactionNotFoundError,
  type WagerTransactionRepository,
} from '../../../application/ports/persistence';
import { FailureCode } from '../../../domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wagering/wager-transaction';
import {
  amount,
  enumValue,
  optionalEnumValue,
  optionalText,
  optionalTimestamp,
  type Row,
  text,
  timestamp,
} from '../row-parsers';

const COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash,
  wallet_id, player_id, round_id, game_id, kind, amount, currency,
  reference_external_transaction_id, reference_transaction_id, status,
  failure_code, processed_at, created_at`;

function toTransaction(row: Row): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: text(row, 'id'),
    providerId: text(row, 'provider_id'),
    externalTransactionId: text(row, 'external_transaction_id'),
    idempotencyKey: text(row, 'idempotency_key'),
    payloadHash: text(row, 'payload_hash'),
    walletId: text(row, 'wallet_id'),
    playerId: text(row, 'player_id'),
    roundId: text(row, 'round_id'),
    gameId: text(row, 'game_id'),
    kind: enumValue(WagerTransactionKind, row, 'kind'),
    money: { amount: amount(row, 'amount'), currency: text(row, 'currency') },
    referenceExternalTransactionId: optionalText(
      row,
      'reference_external_transaction_id',
    ),
    referenceTransactionId: optionalText(row, 'reference_transaction_id'),
    status: enumValue(WagerTransactionStatus, row, 'status'),
    failureCode: optionalEnumValue(FailureCode, row, 'failure_code'),
    processedAt: optionalTimestamp(row, 'processed_at'),
    createdAt: timestamp(row, 'created_at'),
  });
}

export class SqlWagerTransactionRepository implements WagerTransactionRepository {
  async insertIfAbsent(db: DbSession, tx: WagerTransaction): Promise<boolean> {
    // Sem alvo no ON CONFLICT: cobre as duas unicidades (external id e
    // idempotency key). Se outra transação concorrente está inserindo a mesma
    // chave, o INSERT espera o commit dela e então devolve zero linhas.
    const inserted = await db.query<Row>(
      `INSERT INTO wager_transactions (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toString(),
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.processedAt ?? null,
        tx.createdAt,
      ],
    );
    return inserted.length > 0;
  }

  async findById(
    db: DbSession,
    id: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOne(db, 'id = ?', [id]);
  }

  async findByExternalId(
    db: DbSession,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOne(db, 'provider_id = ? AND external_transaction_id = ?', [
      providerId,
      externalTransactionId,
    ]);
  }

  async findByIdempotencyKey(
    db: DbSession,
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOne(db, 'provider_id = ? AND idempotency_key = ?', [
      providerId,
      idempotencyKey,
    ]);
  }

  async saveTransition(db: DbSession, tx: WagerTransaction): Promise<void> {
    // O banco recusa transições ilegais (triggers) mesmo que o domínio falhe.
    const updated = await db.query<Row>(
      `UPDATE wager_transactions
          SET status = ?, reference_transaction_id = ?, failure_code = ?, processed_at = ?
        WHERE id = ?
        RETURNING id`,
      [
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.processedAt ?? null,
        tx.id,
      ],
    );
    if (updated.length === 0) {
      throw new TransactionNotFoundError(tx.id);
    }
  }

  private async findOne(
    db: DbSession,
    where: string,
    params: readonly unknown[],
  ): Promise<WagerTransaction | undefined> {
    const rows = await db.query<Row>(
      `SELECT ${COLUMNS} FROM wager_transactions WHERE ${where}`,
      params,
    );
    return rows[0] === undefined ? undefined : toTransaction(rows[0]);
  }
}
