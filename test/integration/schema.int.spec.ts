import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from './support/test-database';

/**
 * Testa o schema contra um PostgreSQL REAL (sem mocks): cada garantia é
 * exercitada tentando violá-la de propósito. Requer `bun run infra:up`.
 */

type Row = Record<string, unknown>;
type Runner = { unsafe: TestDatabase['sql']['unsafe'] };

const NOW = new Date('2026-01-01T00:00:00.000Z');
const PROCESSED = { status: 'PROCESSED', processed_at: NOW };

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db.close();
});

// ---------------------------------------------------------------- helpers

async function query<T = Row>(text: string, params: unknown[] = []) {
  return (await db.sql.unsafe(text, params)) as T[];
}

/** Espera que a operação falhe com uma mensagem que case com `pattern`. */
async function expectFailure(
  operation: () => Promise<unknown>,
  pattern: RegExp,
) {
  // `toThrow` é tipado como void em bun:test, mas o matcher `rejects` é assíncrono
  await Promise.resolve(
    expect(Promise.resolve().then(operation)).rejects.toThrow(pattern),
  );
}

async function insert(client: Runner, table: string, row: Row) {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  await client.unsafe(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    Object.values(row),
  );
}

const walletRow = (overrides: Row = {}): Row & { id: string } => ({
  id: randomUUID(),
  player_id: `player-${randomUUID()}`,
  currency: 'BRL',
  balance: '0.00',
  version: 1,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const txRow = (
  walletId: string,
  overrides: Row = {},
): Row & { id: string } => ({
  id: randomUUID(),
  provider_id: 'provider-a',
  external_transaction_id: `ext-${randomUUID()}`,
  idempotency_key: `key-${randomUUID()}`,
  payload_hash: 'a'.repeat(64),
  wallet_id: walletId,
  player_id: 'player-1',
  round_id: 'round-1',
  game_id: 'game-1',
  kind: 'BET',
  amount: '25.00',
  currency: 'BRL',
  status: 'PENDING',
  created_at: NOW,
  ...overrides,
});

const ledgerRow = (
  walletId: string,
  transactionId: string,
  overrides: Row = {},
) => ({
  id: randomUUID(),
  wallet_id: walletId,
  transaction_id: transactionId,
  direction: 'DEBIT',
  amount: '25.00',
  currency: 'BRL',
  balance_before: '100.00',
  balance_after: '75.00',
  created_at: NOW,
  ...overrides,
});

/** Wallet sem saldo: dispensa lançamento e aceita inserts avulsos. */
async function emptyWallet(): Promise<string> {
  const wallet = walletRow();
  await insert(db.sql, 'wallets', wallet);
  return wallet.id;
}

/** Fluxo real de `POST /wallets`: wallet + OPENING + lançamento, atômicos. */
async function openFundedWallet(balance = '100.00'): Promise<string> {
  const wallet = walletRow({ balance });
  const opening = txRow(wallet.id, {
    kind: 'OPENING',
    provider_id: 'system',
    amount: balance,
    ...PROCESSED,
  });
  await db.sql.begin(async (tx) => {
    await insert(tx, 'wallets', wallet);
    await insert(tx, 'wager_transactions', opening);
    await insert(
      tx,
      'wallet_ledger_entries',
      ledgerRow(wallet.id, opening.id, {
        direction: 'CREDIT',
        amount: balance,
        balance_before: '0.00',
        balance_after: balance,
      }),
    );
  });
  return wallet.id;
}

interface Movement {
  kind: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  before: string;
  after: string;
  version: number;
  externalId?: string;
  reference?: { externalId: string; id: string };
}

/** Fluxo real de uma operação: tx + ledger + saldo, numa única transação SQL. */
async function applyMovement(
  walletId: string,
  movement: Movement,
): Promise<string> {
  const id = randomUUID();
  await db.sql.begin(async (tx) => {
    await tx.unsafe('SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [
      walletId,
    ]);
    await insert(
      tx,
      'wager_transactions',
      txRow(walletId, {
        id,
        kind: movement.kind,
        amount: movement.amount,
        ...(movement.externalId
          ? { external_transaction_id: movement.externalId }
          : {}),
        ...(movement.reference
          ? { reference_external_transaction_id: movement.reference.externalId }
          : {}),
      }),
    );
    await insert(
      tx,
      'wallet_ledger_entries',
      ledgerRow(walletId, id, {
        direction: movement.direction,
        amount: movement.amount,
        balance_before: movement.before,
        balance_after: movement.after,
      }),
    );
    await tx.unsafe(
      'UPDATE wallets SET balance = $2, version = $3, updated_at = $4 WHERE id = $1',
      [walletId, movement.after, movement.version, NOW],
    );
    await tx.unsafe(
      `UPDATE wager_transactions
          SET status = 'PROCESSED', processed_at = $2, reference_transaction_id = $3
        WHERE id = $1`,
      [id, NOW, movement.reference?.id ?? null],
    );
  });
  return id;
}

const bet = (
  walletId: string,
  before: string,
  after: string,
  version: number,
) =>
  applyMovement(walletId, {
    kind: 'BET',
    direction: 'DEBIT',
    amount: '25.00',
    before,
    after,
    version,
    externalId: `bet-${randomUUID()}`,
  });

// ------------------------------------------------------------- migration

describe('migration', () => {
  it('o down remove tudo e o up pode ser aplicado de novo', async () => {
    const other = await createTestDatabase();
    try {
      const count = async (sql: string) =>
        ((await other.sql.unsafe(sql)) as { n: number }[])[0]?.n;
      const tables = `SELECT count(*)::int AS n FROM information_schema.tables
                       WHERE table_schema = 'public'`;
      const functions = `SELECT count(*)::int AS n FROM pg_proc p
                           JOIN pg_namespace s ON s.oid = p.pronamespace
                          WHERE s.nspname = 'public'`;
      const domains = `SELECT count(*)::int AS n FROM pg_type WHERE typname = 'ext_id'`;

      expect(await count(tables)).toBe(5);
      await other.revertSchema();
      expect(await count(tables)).toBe(0);
      expect(await count(functions)).toBe(0);
      expect(await count(domains)).toBe(0);
      await other.applySchema();
      expect(await count(tables)).toBe(5);
    } finally {
      await other.close();
    }
  });
});

// --------------------------------------------------------------- wallets

describe('wallets', () => {
  it('uma wallet por player + moeda', async () => {
    const first = walletRow({ player_id: 'dup-player' });
    await insert(db.sql, 'wallets', first);
    await expectFailure(
      () => insert(db.sql, 'wallets', walletRow({ player_id: 'dup-player' })),
      /wallets_player_currency_uq/,
    );
    // outra moeda para o mesmo player é permitida
    await insert(
      db.sql,
      'wallets',
      walletRow({ player_id: 'dup-player', currency: 'USD' }),
    );
  });

  it('rejeita saldo negativo', async () => {
    await expectFailure(
      () => insert(db.sql, 'wallets', walletRow({ balance: '-0.01' })),
      /wallets_balance_non_negative/,
    );
  });

  it('rejeita moeda fora do formato ISO-4217', async () => {
    await expectFailure(
      () => insert(db.sql, 'wallets', walletRow({ currency: 'brl' })),
      /wallets_currency_format/,
    );
  });

  it('rejeita player_id vazio ou longo demais (domínio ext_id)', async () => {
    await expectFailure(
      () => insert(db.sql, 'wallets', walletRow({ player_id: '   ' })),
      /ext_id_valid/,
    );
    await expectFailure(
      () =>
        insert(db.sql, 'wallets', walletRow({ player_id: 'p'.repeat(256) })),
      /ext_id_valid/,
    );
    // tab e quebra de linha também contam como "vazio"
    await expectFailure(
      () => insert(db.sql, 'wallets', walletRow({ player_id: '\t\n ' })),
      /ext_id_valid/,
    );
  });

  it('o saldo só muda com version + 1 (versão defasada é conflito 40001)', async () => {
    const id = await openFundedWallet('100.00');
    await expectFailure(
      () =>
        db.sql.unsafe('UPDATE wallets SET balance = 75.00 WHERE id = $1', [id]),
      /stale version/,
    );
    await expectFailure(
      () =>
        db.sql.unsafe(
          'UPDATE wallets SET balance = 75.00, version = 5 WHERE id = $1',
          [id],
        ),
      /stale version/,
    );
  });

  it('a version só muda junto com o saldo', async () => {
    const id = await emptyWallet();
    await expectFailure(
      () => db.sql.unsafe('UPDATE wallets SET version = 2 WHERE id = $1', [id]),
      /version changes only together with the balance/,
    );
  });

  it('a identidade da wallet é imutável', async () => {
    const id = await emptyWallet();
    await expectFailure(
      () =>
        db.sql.unsafe(`UPDATE wallets SET player_id = 'other' WHERE id = $1`, [
          id,
        ]),
      /immutable/,
    );
    await expectFailure(
      () =>
        db.sql.unsafe(`UPDATE wallets SET currency = 'USD' WHERE id = $1`, [
          id,
        ]),
      /immutable/,
    );
  });

  it('não permite apagar wallets (DELETE nem TRUNCATE)', async () => {
    const id = await emptyWallet();
    await expectFailure(
      () => db.sql.unsafe('DELETE FROM wallets WHERE id = $1', [id]),
      /operation DELETE is not allowed on wallets/,
    );
    await expectFailure(
      () => db.sql.unsafe('TRUNCATE wallets CASCADE'),
      /operation TRUNCATE is not allowed on wallets/,
    );
  });

  it('o saldo da wallet precisa bater com o ledger no commit', async () => {
    // wallet com saldo e sem lançamento de abertura
    await expectFailure(
      () => insert(db.sql, 'wallets', walletRow({ balance: '100.00' })),
      /does not match the ledger/,
    );
    // atualização de saldo sem lançamento
    const id = await openFundedWallet('100.00');
    await expectFailure(
      () =>
        db.sql.unsafe(
          'UPDATE wallets SET balance = 75.00, version = 2 WHERE id = $1',
          [id],
        ),
      /does not match the ledger/,
    );
  });
});

// ---------------------------------------------------- wager_transactions

describe('wager_transactions', () => {
  it('dedup persistente: (provider, externalTransactionId) é único', async () => {
    const walletId = await emptyWallet();
    const first = txRow(walletId, { external_transaction_id: 'ext-dup' });
    await insert(db.sql, 'wager_transactions', first);
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { external_transaction_id: 'ext-dup' }),
        ),
      /wager_transactions_provider_external_uq/,
    );
    // o mesmo id externo em outro provider é outra transação
    await insert(
      db.sql,
      'wager_transactions',
      txRow(walletId, {
        external_transaction_id: 'ext-dup',
        provider_id: 'provider-b',
      }),
    );
  });

  it('a idempotency key é única por provider', async () => {
    const walletId = await emptyWallet();
    await insert(
      db.sql,
      'wager_transactions',
      txRow(walletId, { idempotency_key: 'key-dup' }),
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { idempotency_key: 'key-dup' }),
        ),
      /wager_transactions_idempotency_key_uq/,
    );
    // outro provider pode usar a mesma chave sem colidir (nem enxergar a de outro)
    await insert(
      db.sql,
      'wager_transactions',
      txRow(walletId, {
        idempotency_key: 'key-dup',
        provider_id: 'provider-b',
      }),
    );
  });

  it('50 inserts concorrentes com a mesma chave resultam em exatamente 1 linha', async () => {
    const walletId = await emptyWallet();
    const key = `race-${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { idempotency_key: key }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(String(result.reason)).toMatch(
          /wager_transactions_idempotency_key_uq|wager_transactions_provider_external_uq/,
        );
      }
    }
    const [row] = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM wager_transactions WHERE idempotency_key = $1',
      [key],
    );
    expect(row?.n).toBe(1);
  });

  it('valida kind, status, hash e moeda', async () => {
    const walletId = await emptyWallet();
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { kind: 'DEPOSIT' }),
        ),
      /wager_transactions_kind_valid/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { status: 'DONE' }),
        ),
      /wager_transactions_status_valid/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { payload_hash: 'XYZ' }),
        ),
      /wager_transactions_payload_hash_format/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { currency: 'real' }),
        ),
      /value too long|wager_transactions_currency_format/,
    );
  });

  it('só LOSS aceita valor zero; nenhum aceita negativo', async () => {
    const walletId = await emptyWallet();
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { amount: '0.00' }),
        ),
      /wager_transactions_amount_valid/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { kind: 'LOSS', amount: '-1.00' }),
        ),
      /wager_transactions_amount_valid/,
    );
    await insert(
      db.sql,
      'wager_transactions',
      txRow(walletId, { kind: 'LOSS', amount: '0.00' }),
    );
  });

  it('REFUND e ROLLBACK exigem referência; BET e OPENING não podem ter', async () => {
    const walletId = await emptyWallet();
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectFailure(
        () => insert(db.sql, 'wager_transactions', txRow(walletId, { kind })),
        /wager_transactions_reference_required/,
      );
    }
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, {
            kind: 'BET',
            reference_external_transaction_id: 'x',
          }),
        ),
      /wager_transactions_reference_forbidden/,
    );
  });

  it('não permite referenciar a si mesma', async () => {
    const walletId = await emptyWallet();
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, {
            kind: 'REFUND',
            external_transaction_id: 'same',
            reference_external_transaction_id: 'same',
          }),
        ),
      /wager_transactions_no_self_reference/,
    );
  });

  it('o failure_code acompanha exatamente os status REJECTED e FAILED', async () => {
    const walletId = await emptyWallet();
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { status: 'REJECTED' }),
        ),
      /wager_transactions_failure_code_matches_status/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, {
            status: 'PENDING',
            failure_code: 'INSUFFICIENT_FUNDS',
          }),
        ),
      /wager_transactions_failure_code_matches_status/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, {
            status: 'REJECTED',
            failure_code: 'insufficient funds',
          }),
        ),
      /wager_transactions_failure_code_format/,
    );
    await insert(
      db.sql,
      'wager_transactions',
      txRow(walletId, {
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
      }),
    );
  });

  it('processed_at acompanha exatamente o status PROCESSED', async () => {
    const walletId = await emptyWallet();
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { status: 'PROCESSED' }),
        ),
      /wager_transactions_processed_at_matches_status/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { processed_at: NOW }),
        ),
      /wager_transactions_processed_at_matches_status/,
    );
  });

  it('next_attempt_at existe se e somente se o status é PENDING_REFERENCE', async () => {
    const walletId = await emptyWallet();
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, { next_attempt_at: NOW }),
        ),
      /wager_transactions_retry_state_valid/,
    );
    // PENDING_REFERENCE sem próxima tentativa nunca seria reprocessada
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, {
            kind: 'REFUND',
            reference_external_transaction_id: 'bet-missing',
            status: 'PENDING_REFERENCE',
          }),
        ),
      /wager_transactions_retry_state_valid/,
    );
    await insert(
      db.sql,
      'wager_transactions',
      txRow(walletId, {
        kind: 'REFUND',
        reference_external_transaction_id: 'bet-missing',
        status: 'PENDING_REFERENCE',
        next_attempt_at: NOW,
        reference_attempts: 2,
      }),
    );
  });

  it('estados terminais não mudam mais, nem podem ser apagados', async () => {
    const walletId = await emptyWallet();
    const rejected = txRow(walletId, {
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    await insert(db.sql, 'wager_transactions', rejected);

    await expectFailure(
      () =>
        db.sql.unsafe(
          `UPDATE wager_transactions SET status = 'FAILED', failure_code = 'PERMANENT_INFRASTRUCTURE_ERROR' WHERE id = $1`,
          [rejected.id],
        ),
      /REJECTED is a terminal status/,
    );
    await expectFailure(
      () =>
        db.sql.unsafe('DELETE FROM wager_transactions WHERE id = $1', [
          rejected.id,
        ]),
      /operation DELETE is not allowed on wager_transactions/,
    );
    await expectFailure(
      () => db.sql.unsafe('TRUNCATE wager_transactions CASCADE'),
      /operation TRUNCATE is not allowed on wager_transactions/,
    );
  });

  it('a identidade da operação é imutável e PENDING não volta de PENDING_REFERENCE', async () => {
    const walletId = await emptyWallet();
    const refund = txRow(walletId, {
      kind: 'REFUND',
      reference_external_transaction_id: 'bet-x',
    });
    await insert(db.sql, 'wager_transactions', refund);

    await expectFailure(
      () =>
        db.sql.unsafe(
          `UPDATE wager_transactions SET amount = 99.00 WHERE id = $1`,
          [refund.id],
        ),
      /identity of a transaction is immutable/,
    );

    await db.sql.unsafe(
      `UPDATE wager_transactions SET status = 'PENDING_REFERENCE', next_attempt_at = $2 WHERE id = $1`,
      [refund.id, NOW],
    );
    await expectFailure(
      () =>
        db.sql.unsafe(
          `UPDATE wager_transactions SET status = 'PENDING', next_attempt_at = NULL WHERE id = $1`,
          [refund.id],
        ),
      /cannot go back to PENDING/,
    );
    // PENDING_REFERENCE continua reprocessável e pode ser rejeitada
    await db.sql.unsafe(
      `UPDATE wager_transactions
          SET status = 'REJECTED', failure_code = 'REFERENCE_NOT_FOUND', next_attempt_at = NULL
        WHERE id = $1`,
      [refund.id],
    );
  });

  it('wallet_id precisa existir', async () => {
    await expectFailure(
      () => insert(db.sql, 'wager_transactions', txRow(randomUUID())),
      /wager_transactions_wallet_id_fkey/,
    );
  });
});

// ---------------------------------------------------- reversões

describe('reversões', () => {
  it('uma referência só pode ser revertida uma vez (REFUND ou ROLLBACK)', async () => {
    const walletId = await openFundedWallet('100.00');
    const betExternal = `bet-${randomUUID()}`;
    const betId = await applyMovement(walletId, {
      kind: 'BET',
      direction: 'DEBIT',
      amount: '25.00',
      before: '100.00',
      after: '75.00',
      version: 2,
      externalId: betExternal,
    });
    const reference = { externalId: betExternal, id: betId };

    await applyMovement(walletId, {
      kind: 'REFUND',
      direction: 'CREDIT',
      amount: '25.00',
      before: '75.00',
      after: '100.00',
      version: 3,
      reference,
    });

    // segundo REFUND da mesma BET
    await expectFailure(
      () =>
        applyMovement(walletId, {
          kind: 'REFUND',
          direction: 'CREDIT',
          amount: '25.00',
          before: '100.00',
          after: '125.00',
          version: 4,
          reference,
        }),
      /wager_transactions_reversal_uq/,
    );
    // ROLLBACK da mesma BET também conta como reversão (evita crédito duplo)
    await expectFailure(
      () =>
        applyMovement(walletId, {
          kind: 'ROLLBACK',
          direction: 'CREDIT',
          amount: '25.00',
          before: '100.00',
          after: '125.00',
          version: 4,
          reference,
        }),
      /wager_transactions_reversal_uq/,
    );

    const [row] = await query<{ balance: string; version: number }>(
      'SELECT balance, version FROM wallets WHERE id = $1',
      [walletId],
    );
    expect(row).toEqual({ balance: '100.00', version: 3 });
  });

  it('várias WIN podem referenciar a mesma BET', async () => {
    const walletId = await openFundedWallet('100.00');
    const betExternal = `bet-${randomUUID()}`;
    const betId = await applyMovement(walletId, {
      kind: 'BET',
      direction: 'DEBIT',
      amount: '25.00',
      before: '100.00',
      after: '75.00',
      version: 2,
      externalId: betExternal,
    });
    const reference = { externalId: betExternal, id: betId };
    await applyMovement(walletId, {
      kind: 'WIN',
      direction: 'CREDIT',
      amount: '10.00',
      before: '75.00',
      after: '85.00',
      version: 3,
      reference,
    });
    await applyMovement(walletId, {
      kind: 'WIN',
      direction: 'CREDIT',
      amount: '10.00',
      before: '85.00',
      after: '95.00',
      version: 4,
      reference,
    });
    const [row] = await query<{ balance: string }>(
      'SELECT balance FROM wallets WHERE id = $1',
      [walletId],
    );
    expect(row?.balance).toBe('95.00');
  });

  it('uma reversão processada exige a referência resolvida', async () => {
    const walletId = await emptyWallet();
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wager_transactions',
          txRow(walletId, {
            kind: 'REFUND',
            reference_external_transaction_id: 'bet-x',
            ...PROCESSED,
          }),
        ),
      /wager_transactions_reversal_processed_has_reference/,
    );
  });

  it('a direção do ROLLBACK é o inverso da referência', async () => {
    const walletId = await openFundedWallet('100.00');
    const betExternal = `bet-${randomUUID()}`;
    const betId = await applyMovement(walletId, {
      kind: 'BET',
      direction: 'DEBIT',
      amount: '25.00',
      before: '100.00',
      after: '75.00',
      version: 2,
      externalId: betExternal,
    });
    const reference = { externalId: betExternal, id: betId };

    // rollback de BET debitaria de novo: direção errada
    await expectFailure(
      () =>
        applyMovement(walletId, {
          kind: 'ROLLBACK',
          direction: 'DEBIT',
          amount: '25.00',
          before: '75.00',
          after: '50.00',
          version: 3,
          reference,
        }),
      /requires direction CREDIT but got DEBIT/,
    );
    await applyMovement(walletId, {
      kind: 'ROLLBACK',
      direction: 'CREDIT',
      amount: '25.00',
      before: '75.00',
      after: '100.00',
      version: 3,
      reference,
    });
  });
});

// ---------------------------------------- integridade da referência

describe('reversões: a transação referenciada é validada pelo banco', () => {
  async function fundedWithBet(amount = '25.00') {
    const walletId = await openFundedWallet('100.00');
    const externalId = `bet-${randomUUID()}`;
    const id = await applyMovement(walletId, {
      kind: 'BET',
      direction: 'DEBIT',
      amount,
      before: '100.00',
      after: (100 - Number(amount)).toFixed(2),
      version: 2,
      externalId,
    });
    return { walletId, reference: { externalId, id } };
  }

  it('não reverte uma transação que não foi PROCESSED', async () => {
    const walletId = await openFundedWallet('100.00');
    const externalId = `bet-${randomUUID()}`;
    const rejected = txRow(walletId, {
      external_transaction_id: externalId,
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    await insert(db.sql, 'wager_transactions', rejected);

    await expectFailure(
      () =>
        applyMovement(walletId, {
          kind: 'REFUND',
          direction: 'CREDIT',
          amount: '25.00',
          before: '100.00',
          after: '125.00',
          version: 2,
          reference: { externalId, id: rejected.id },
        }),
      /the referenced transaction must be PROCESSED/,
    );
  });

  it('a reversão tem o mesmo valor da referência', async () => {
    const { walletId, reference } = await fundedWithBet('25.00');
    await expectFailure(
      () =>
        applyMovement(walletId, {
          kind: 'REFUND',
          direction: 'CREDIT',
          amount: '20.00',
          before: '75.00',
          after: '95.00',
          version: 3,
          reference,
        }),
      /same amount and currency as its reference/,
    );
  });

  it('REFUND só reverte BET e ROLLBACK não reverte OPENING', async () => {
    const { walletId, reference: betRef } = await fundedWithBet('25.00');

    const winExternal = `win-${randomUUID()}`;
    const winId = await applyMovement(walletId, {
      kind: 'WIN',
      direction: 'CREDIT',
      amount: '10.00',
      before: '75.00',
      after: '85.00',
      version: 3,
      externalId: winExternal,
      reference: betRef,
    });
    await expectFailure(
      () =>
        applyMovement(walletId, {
          kind: 'REFUND',
          direction: 'CREDIT',
          amount: '10.00',
          before: '85.00',
          after: '95.00',
          version: 4,
          reference: { externalId: winExternal, id: winId },
        }),
      /a REFUND cannot reference a WIN/,
    );

    // wallet isolada: só a abertura de 100.00, para a aritmética não mascarar a regra de tipo
    const openOnly = await openFundedWallet('100.00');
    const [opening] = await query<{
      id: string;
      external_transaction_id: string;
    }>(
      `SELECT id, external_transaction_id FROM wager_transactions
        WHERE wallet_id = $1 AND kind = 'OPENING'`,
      [openOnly],
    );
    await expectFailure(
      () =>
        applyMovement(openOnly, {
          kind: 'ROLLBACK',
          direction: 'DEBIT',
          amount: '100.00',
          before: '100.00',
          after: '0.00',
          version: 2,
          reference: {
            externalId: opening?.external_transaction_id ?? '',
            id: opening?.id ?? '',
          },
        }),
      /a ROLLBACK cannot reference a OPENING/,
    );
  });

  it('a referência resolvida pertence à mesma wallet', async () => {
    const { reference } = await fundedWithBet('25.00');
    const otherWallet = await openFundedWallet('100.00');
    await expectFailure(
      () =>
        applyMovement(otherWallet, {
          kind: 'REFUND',
          direction: 'CREDIT',
          amount: '25.00',
          before: '100.00',
          after: '125.00',
          version: 2,
          reference,
        }),
      /wager_transactions_reference_fk/,
    );
  });
});

// ---------------------------------------------------------------- ledger

describe('wallet_ledger_entries', () => {
  it('fluxo completo: saldo, transação e ledger confirmados juntos', async () => {
    const walletId = await openFundedWallet('1000.00');
    await bet(walletId, '1000.00', '975.00', 2);

    const [wallet] = await query<{ balance: string; version: number }>(
      'SELECT balance, version FROM wallets WHERE id = $1',
      [walletId],
    );
    expect(wallet).toEqual({ balance: '975.00', version: 2 });

    const entries = await query<{ direction: string; amount: string }>(
      'SELECT direction, amount FROM wallet_ledger_entries WHERE wallet_id = $1 ORDER BY seq',
      [walletId],
    );
    expect(entries).toEqual([
      { direction: 'CREDIT', amount: '1000.00' },
      { direction: 'DEBIT', amount: '25.00' },
    ]);
  });

  it('wallet.balance == saldo reconstruído pelo ledger', async () => {
    const walletId = await openFundedWallet('1000.00');
    await bet(walletId, '1000.00', '975.00', 2);
    await bet(walletId, '975.00', '950.00', 3);
    await applyMovement(walletId, {
      kind: 'WIN',
      direction: 'CREDIT',
      amount: '25.00',
      before: '950.00',
      after: '975.00',
      version: 4,
    });

    const [row] = await query<{ balance: string; rebuilt: string }>(
      `SELECT w.balance,
              COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS rebuilt
         FROM wallets w
         LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
        WHERE w.id = $1
        GROUP BY w.balance`,
      [walletId],
    );
    expect(row?.balance).toBe('975.00');
    expect(row?.rebuilt).toBe('975.00');
  });

  it('é imutável: sem UPDATE, DELETE nem TRUNCATE', async () => {
    const walletId = await openFundedWallet('100.00');
    await expectFailure(
      () =>
        db.sql.unsafe(
          `UPDATE wallet_ledger_entries SET amount = 1.00 WHERE wallet_id = $1`,
          [walletId],
        ),
      /operation UPDATE is not allowed on wallet_ledger_entries/,
    );
    await expectFailure(
      () =>
        db.sql.unsafe(
          'DELETE FROM wallet_ledger_entries WHERE wallet_id = $1',
          [walletId],
        ),
      /operation DELETE is not allowed on wallet_ledger_entries/,
    );
    await expectFailure(
      () => db.sql.unsafe('TRUNCATE wallet_ledger_entries'),
      /operation TRUNCATE is not allowed on wallet_ledger_entries/,
    );
  });

  it('a aritmética do lançamento é verificada pelo banco', async () => {
    const walletId = await emptyWallet();
    const tx = txRow(walletId);
    await insert(db.sql, 'wager_transactions', tx);
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow(walletId, tx.id, { balance_after: '75.01' }),
        ),
      /wallet_ledger_entries_arithmetic/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow(walletId, tx.id, { direction: 'CREDIT' }),
        ),
      /wallet_ledger_entries_arithmetic/,
    );
  });

  it('valor positivo, saldos não negativos e direção válida', async () => {
    const walletId = await emptyWallet();
    const tx = txRow(walletId);
    await insert(db.sql, 'wager_transactions', tx);
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow(walletId, tx.id, {
            amount: '0.00',
            balance_before: '10.00',
            balance_after: '10.00',
          }),
        ),
      /wallet_ledger_entries_amount_positive/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow(walletId, tx.id, {
            balance_before: '10.00',
            balance_after: '-15.00',
          }),
        ),
      /wallet_ledger_entries_balances_non_negative/,
    );
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow(walletId, tx.id, { direction: 'SIDEWAYS' }),
        ),
      // o banco avalia as CHECKs em ordem alfabética: a aritmética (que também
      // não aceita uma direção desconhecida) aparece antes de direction_valid
      /wallet_ledger_entries_(arithmetic|direction_valid)/,
    );
  });

  it('no máximo um lançamento por transação', async () => {
    const walletId = await openFundedWallet('100.00');
    const betId = await bet(walletId, '100.00', '75.00', 2);
    await expectFailure(
      () =>
        insert(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow(walletId, betId, {
            balance_before: '75.00',
            balance_after: '50.00',
          }),
        ),
      /wallet_ledger_entries_transaction_wallet_uq/,
    );
  });

  it('a moeda do lançamento é a da wallet e a wallet é a da transação', async () => {
    const walletId = await emptyWallet();
    const other = await emptyWallet();
    const tx = txRow(walletId);
    await insert(db.sql, 'wager_transactions', tx);

    await expectFailure(
      () =>
        insert(
          db.sql,
          'wallet_ledger_entries',
          ledgerRow(walletId, tx.id, { currency: 'USD' }),
        ),
      /wallet_ledger_entries_wallet_currency_fk/,
    );
    await expectFailure(
      () => insert(db.sql, 'wallet_ledger_entries', ledgerRow(other, tx.id)),
      /wallet_ledger_entries_transaction_wallet_fk/,
    );
  });

  it('a cadeia de saldos não pode ter buracos', async () => {
    const walletId = await openFundedWallet('100.00');
    // before = 90 não bate com o último balance_after (100)
    await expectFailure(
      () => bet(walletId, '90.00', '65.00', 2),
      /chain broken/,
    );
  });

  it('só transações PROCESSED que movem saldo geram lançamento', async () => {
    const walletId = await openFundedWallet('100.00');
    const loss = txRow(walletId, { kind: 'LOSS', amount: '25.00' });
    await expectFailure(
      () =>
        db.sql.begin(async (tx) => {
          await insert(tx, 'wager_transactions', { ...loss, ...PROCESSED });
          await insert(
            tx,
            'wallet_ledger_entries',
            ledgerRow(walletId, loss.id, {
              balance_before: '100.00',
              balance_after: '75.00',
            }),
          );
          await tx.unsafe(
            'UPDATE wallets SET balance = 75.00, version = 2 WHERE id = $1',
            [walletId],
          );
        }),
      /must be PROCESSED and affect the balance/,
    );

    // transação ainda PENDING com lançamento também é rejeitada
    const pending = txRow(walletId);
    await expectFailure(
      () =>
        db.sql.begin(async (tx) => {
          await insert(tx, 'wager_transactions', pending);
          await insert(
            tx,
            'wallet_ledger_entries',
            ledgerRow(walletId, pending.id),
          );
          await tx.unsafe(
            'UPDATE wallets SET balance = 75.00, version = 2 WHERE id = $1',
            [walletId],
          );
        }),
      /must be PROCESSED and affect the balance/,
    );
  });

  it('valor, moeda e direção precisam coincidir com a transação', async () => {
    const walletId = await openFundedWallet('100.00');
    const make = (entry: Row, after: string) => async () => {
      const bet = txRow(walletId);
      await db.sql.begin(async (tx) => {
        await insert(tx, 'wager_transactions', bet);
        await insert(
          tx,
          'wallet_ledger_entries',
          ledgerRow(walletId, bet.id, entry),
        );
        await tx.unsafe(
          'UPDATE wallets SET balance = $2, version = 2 WHERE id = $1',
          [walletId, after],
        );
        await tx.unsafe(
          `UPDATE wager_transactions SET status = 'PROCESSED', processed_at = $2 WHERE id = $1`,
          [bet.id, NOW],
        );
      });
    };

    // BET de 25.00 com lançamento de 30.00
    await expectFailure(
      make({ amount: '30.00', balance_after: '70.00' }, '70.00'),
      /amount and currency must match the transaction/,
    );
    // BET lançada como crédito
    await expectFailure(
      make({ direction: 'CREDIT', balance_after: '125.00' }, '125.00'),
      /requires direction DEBIT but got CREDIT/,
    );
  });

  it('um lançamento sem a atualização da wallet não passa no commit', async () => {
    const walletId = await openFundedWallet('100.00');
    await expectFailure(
      () =>
        db.sql.begin(async (tx) => {
          const bet = txRow(walletId);
          await insert(tx, 'wager_transactions', bet);
          await insert(
            tx,
            'wallet_ledger_entries',
            ledgerRow(walletId, bet.id),
          );
          await tx.unsafe(
            `UPDATE wager_transactions SET status = 'PROCESSED', processed_at = $2 WHERE id = $1`,
            [bet.id, NOW],
          );
          // esqueceu: UPDATE wallets SET balance = 75.00, version = 2
        }),
      /does not match the ledger/,
    );
  });

  it('toda transação PROCESSED que move saldo precisa do seu lançamento', async () => {
    const walletId = await emptyWallet();
    await expectFailure(
      () =>
        db.sql.begin(async (tx) => {
          const bet = txRow(walletId);
          await insert(tx, 'wager_transactions', bet);
          await tx.unsafe(
            `UPDATE wager_transactions SET status = 'PROCESSED', processed_at = $2 WHERE id = $1`,
            [bet.id, NOW],
          );
        }),
      /has no ledger entry/,
    );

    // LOSS processada não move saldo e não precisa de lançamento
    await db.sql.begin(async (tx) => {
      const loss = txRow(walletId, {
        kind: 'LOSS',
        amount: '25.00',
        ...PROCESSED,
      });
      await insert(tx, 'wager_transactions', loss);
    });
  });

  it('uma transação que falha no meio não deixa nada para trás (atomicidade)', async () => {
    const walletId = await openFundedWallet('100.00');
    const orphan = txRow(walletId);
    await expectFailure(
      () =>
        db.sql.begin(async (tx) => {
          await insert(tx, 'wager_transactions', orphan);
          await insert(
            tx,
            'wallet_ledger_entries',
            ledgerRow(walletId, orphan.id, { balance_after: '1.00' }), // aritmética inválida
          );
        }),
      /wallet_ledger_entries_arithmetic/,
    );
    const [row] = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM wager_transactions WHERE id = $1',
      [orphan.id],
    );
    expect(row?.n).toBe(0);
  });
});

// ---------------------------------------------------------- inbox / outbox

describe('inbox_messages', () => {
  const inbox = (overrides: Row = {}) => ({
    consumer_name: 'wager-consumer',
    message_id: `msg-${randomUUID()}`,
    payload_hash: 'b'.repeat(64),
    received_at: NOW,
    ...overrides,
  });

  it('deduplica por (consumer_name, message_id)', async () => {
    const message = inbox({ message_id: 'msg-dup' });
    await insert(db.sql, 'inbox_messages', message);
    await expectFailure(
      () => insert(db.sql, 'inbox_messages', message),
      /inbox_messages_pk/,
    );
    // outro consumidor pode receber a mesma mensagem
    await insert(db.sql, 'inbox_messages', {
      ...message,
      consumer_name: 'audit-consumer',
    });
  });

  it('50 recebimentos concorrentes da mesma mensagem processam uma vez', async () => {
    const message = inbox({ message_id: `race-${randomUUID()}` });
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () =>
        insert(db.sql, 'inbox_messages', message),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('valida o formato do hash', async () => {
    await expectFailure(
      () => insert(db.sql, 'inbox_messages', inbox({ payload_hash: 'nope' })),
      /value too long|inbox_messages_payload_hash_format/,
    );
  });
});

describe('outbox_messages', () => {
  const outbox = (overrides: Row = {}) => ({
    id: randomUUID(),
    aggregate_id: 'wallet-1',
    event_type: 'WalletBalanceChanged',
    payload: { eventId: 'e1', data: { walletId: 'wallet-1' } } as unknown,
    occurred_at: NOW,
    attempts: 0,
    ...overrides,
  });

  /**
   * O payload entra como TEXTO e é convertido no SQL: o driver serializaria
   * uma string passada a um parâmetro jsonb como string JSON (escalar).
   */
  async function insertOutbox(message: ReturnType<typeof outbox>) {
    await db.sql.unsafe(
      `INSERT INTO outbox_messages
         (id, aggregate_id, event_type, payload, occurred_at, attempts)
       VALUES ($1, $2, $3, $4::text::jsonb, $5, $6)`,
      [
        message.id,
        message.aggregate_id,
        message.event_type,
        JSON.stringify(message.payload),
        message.occurred_at,
        message.attempts,
      ],
    );
  }

  it('guarda o payload como objeto JSON', async () => {
    await insertOutbox(outbox());
    await expectFailure(
      () => insertOutbox(outbox({ payload: [1, 2] })),
      /outbox_messages_payload_is_object/,
    );
    await expectFailure(
      () => insertOutbox(outbox({ payload: 'texto solto' })),
      /outbox_messages_payload_is_object/,
    );
  });

  it('attempts não é negativo e começa em 0', async () => {
    const message = outbox();
    await db.sql.unsafe(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       VALUES ($1, $2, $3, '{"eventId":"e2"}'::jsonb, $4)`,
      [message.id, message.aggregate_id, message.event_type, NOW],
    );
    const [row] = await query<{ attempts: number }>(
      'SELECT attempts FROM outbox_messages WHERE id = $1',
      [message.id],
    );
    expect(row?.attempts).toBe(0);
    await expectFailure(
      () => insertOutbox(outbox({ attempts: -1 })),
      /outbox_messages_attempts_non_negative/,
    );
  });

  it('seq define a ordem de publicação, independente do relógio', async () => {
    const early = outbox({
      aggregate_id: 'order-a',
      occurred_at: new Date(NOW.getTime() + 60_000),
    });
    const late = outbox({ aggregate_id: 'order-b', occurred_at: NOW });
    await insertOutbox(early);
    await insertOutbox(late);
    const rows = await query<{ aggregate_id: string }>(
      `SELECT aggregate_id FROM outbox_messages
        WHERE aggregate_id IN ('order-a', 'order-b') ORDER BY seq`,
    );
    // o primeiro inserido é o primeiro a publicar, mesmo com occurred_at maior
    expect(rows.map((row) => row.aggregate_id)).toEqual(['order-a', 'order-b']);
  });

  it('dois publishers concorrentes não pegam a mesma mensagem (SKIP LOCKED)', async () => {
    for (let i = 0; i < 10; i++) {
      await insertOutbox(
        outbox({
          aggregate_id: `skip-locked-${i}`,
          occurred_at: new Date(NOW.getTime() + i),
        }),
      );
    }
    const claim = (hold: Promise<void>) =>
      db.sql.begin(async (tx) => {
        const rows = (await tx.unsafe(
          `SELECT id FROM outbox_messages
            WHERE published_at IS NULL AND aggregate_id LIKE 'skip-locked-%'
            ORDER BY seq
            LIMIT 5
              FOR UPDATE SKIP LOCKED`,
        )) as { id: string }[];
        await hold; // mantém o lock até o outro publisher também ter reivindicado
        return rows.map((row) => row.id);
      });

    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = claim(hold);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = claim(hold);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toHaveLength(5);
    expect(b).toHaveLength(5);
    expect(new Set([...a, ...b]).size).toBe(10);
  });
});
