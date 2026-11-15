import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  IdempotencyConflictError,
  PlayerWalletMismatchError,
  WalletNotFoundError,
} from '../../src/application/errors';
import type { OutboxRepository } from '../../src/application/ports/persistence';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/application/process-wager-transaction/process-wager-transaction.use-case';
import { ledgerBalance } from '../../src/domain/ledger/ledger-balance';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import {
  InvalidMoneyError,
  InvalidTransactionError,
} from '../../src/domain/shared/domain-error';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction';
import { SqlInboxRepository } from '../../src/infrastructure/persistence/repositories/inbox.repository';
import { SqlLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository';
import { SqlOutboxRepository } from '../../src/infrastructure/persistence/repositories/outbox.repository';
import { SqlWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/wager-transaction.repository';
import { SqlWalletRepository } from '../../src/infrastructure/persistence/repositories/wallet.repository';
import { SystemClock } from '../../src/infrastructure/runtime/system-clock';
import { UuidGenerator } from '../../src/infrastructure/runtime/uuid-generator';
import { BunTransactionRunner } from './support/bun-transaction-runner';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { openWallet } from './support/wallet-fixtures';

/**
 * Caso de uso de BET contra PostgreSQL real: nada é mockado. Cada teste tenta
 * quebrar uma garantia (saldo negativo, débito duplicado, evento perdido).
 */

const wallets = new SqlWalletRepository();
const transactions = new SqlWagerTransactionRepository();
const ledger = new SqlLedgerRepository();

let database: TestDatabase;
let runner: BunTransactionRunner;
let useCase: ProcessWagerTransactionUseCase;

function buildUseCase(outbox: OutboxRepository = new SqlOutboxRepository()) {
  return new ProcessWagerTransactionUseCase({
    runner,
    wallets,
    transactions,
    ledger,
    inbox: new SqlInboxRepository(),
    outbox,
    clock: new SystemClock(),
    ids: new UuidGenerator(),
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  runner = new BunTransactionRunner(database.sql);
  useCase = buildUseCase();
});

afterAll(async () => {
  await database.close();
});

function bet(
  wallet: { walletId: string; playerId: string },
  amount: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const id = randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId: `bet-${id}`,
    idempotencyKey: `key-${id}`,
    walletId: wallet.walletId,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

/** Devolve o erro da promise; falha se ela resolver. Evita `await expect(...).rejects`. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

async function snapshot(walletId: string) {
  return runner.read(async (db) => {
    const wallet = await wallets.findById(db, walletId);
    const entries = await ledger.findByWalletId(db, walletId);
    return { wallet, entries };
  });
}

interface OutboxRow {
  event_type: string;
  aggregate_id: string;
  payload: {
    data: Record<string, unknown>;
    eventType: string;
    version: number;
  };
}

async function outboxFor(walletId: string): Promise<OutboxRow[]> {
  const rows: unknown = await database.sql.unsafe(
    `SELECT event_type, aggregate_id, payload FROM outbox_messages
      WHERE aggregate_id = $1 ORDER BY seq`,
    [walletId],
  );
  return rows as OutboxRow[];
}

describe('BET aprovada', () => {
  it('debita o saldo, grava ledger, status PROCESSED e os eventos na outbox', async () => {
    const wallet = await openWallet(runner, '100.00');
    const result = await useCase.execute(bet(wallet, '30.00'));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.failureCode).toBeUndefined();
    expect(result.idempotentReplay).toBe(false);
    expect(result.walletBalance).toEqual({ amount: '70.00', currency: 'BRL' });

    const { wallet: stored, entries } = await snapshot(wallet.walletId);
    expect(stored?.balance.toString()).toBe('70.00');
    expect(stored?.version).toBe(2);
    expect(entries).toHaveLength(2); // abertura + aposta
    expect(entries[1]?.direction).toBe(LedgerDirection.Debit);
    expect(entries[1]?.money.toString()).toBe('30.00');
    expect(entries[1]?.balanceBefore.toString()).toBe('100.00');
    expect(entries[1]?.balanceAfter.toString()).toBe('70.00');
    expect(entries[1]?.transactionId).toBe(result.transactionId);

    const events = await outboxFor(wallet.walletId);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const changed = events[1]?.payload.data as {
      balanceBefore: unknown;
      balanceAfter: unknown;
      money: unknown;
    };
    // dinheiro viaja como string decimal, nunca como number
    expect(changed.money).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(changed.balanceBefore).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
    expect(changed.balanceAfter).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(events[0]?.payload.version).toBe(1);
  });

  it('aceita zerar o saldo exatamente', async () => {
    const wallet = await openWallet(runner, '10.00');
    const result = await useCase.execute(bet(wallet, '10.00'));
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.walletBalance.amount).toBe('0.00');
  });

  it('não perde centavos em valores quebrados', async () => {
    const wallet = await openWallet(runner, '0.30');
    await useCase.execute(bet(wallet, '0.10'));
    await useCase.execute(bet(wallet, '0.10'));
    const { wallet: stored } = await snapshot(wallet.walletId);
    expect(stored?.balance.toString()).toBe('0.10'); // 0.30 - 0.10 - 0.10, sem erro de float
  });
});

describe('BET rejeitada', () => {
  it('sem saldo: REJECTED/INSUFFICIENT_FUNDS, nada no ledger, só o evento de rejeição', async () => {
    const wallet = await openWallet(runner, '50.00');
    const result = await useCase.execute(bet(wallet, '50.01'));

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.walletBalance.amount).toBe('50.00');

    const { wallet: stored, entries } = await snapshot(wallet.walletId);
    expect(stored?.balance.toString()).toBe('50.00');
    expect(stored?.version).toBe(1);
    expect(entries).toHaveLength(1); // só a abertura

    const events = await outboxFor(wallet.walletId);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionRejected',
    ]);
    expect(events[0]?.payload.data['failureCode']).toBe('INSUFFICIENT_FUNDS');
  });

  it('moeda diferente da wallet: REJECTED/CURRENCY_MISMATCH', async () => {
    const wallet = await openWallet(runner, '100.00');
    const result = await useCase.execute(
      bet(wallet, '10.00', { money: { amount: '10.00', currency: 'USD' } }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect((await snapshot(wallet.walletId)).wallet?.balance.toString()).toBe(
      '100.00',
    );
  });
});

describe('entradas inválidas não persistem nada', () => {
  it('wallet inexistente', async () => {
    const command = bet(
      { walletId: randomUUID(), playerId: 'player-x' },
      '10.00',
    );
    expect(await rejection(useCase.execute(command))).toBeInstanceOf(
      WalletNotFoundError,
    );
    const found = await runner.read((db) =>
      transactions.findByExternalId(
        db,
        command.providerId,
        command.externalTransactionId,
      ),
    );
    expect(found).toBeUndefined();
  });

  it('player que não é o dono da wallet', async () => {
    const wallet = await openWallet(runner, '100.00');
    expect(
      await rejection(
        useCase.execute(bet({ ...wallet, playerId: 'intruso' }, '10.00')),
      ),
    ).toBeInstanceOf(PlayerWalletMismatchError);
    expect((await snapshot(wallet.walletId)).wallet?.balance.toString()).toBe(
      '100.00',
    );
  });

  it.each(['10.005', '-5.00', '1e3', '10,50'])(
    'valor malformado %p',
    async (amount) => {
      const wallet = await openWallet(runner, '100.00');
      expect(
        await rejection(useCase.execute(bet(wallet, amount))),
      ).toBeInstanceOf(InvalidMoneyError);
      expect((await snapshot(wallet.walletId)).wallet?.balance.toString()).toBe(
        '100.00',
      );
    },
  );

  it('BET de valor zero é recusada pela regra de domínio, sem persistir nada', async () => {
    const wallet = await openWallet(runner, '100.00');
    expect(
      await rejection(useCase.execute(bet(wallet, '0.00'))),
    ).toBeInstanceOf(InvalidTransactionError);
    expect((await snapshot(wallet.walletId)).wallet?.balance.toString()).toBe(
      '100.00',
    );
  });
});

describe('idempotência', () => {
  it('mesma chave e mesmo payload: devolve o resultado original sem reaplicar', async () => {
    const wallet = await openWallet(runner, '100.00');
    const command = bet(wallet, '40.00');
    const first = await useCase.execute(command);
    const second = await useCase.execute(command);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.status).toBe(WagerTransactionStatus.Processed);

    const { wallet: stored, entries } = await snapshot(wallet.walletId);
    expect(stored?.balance.toString()).toBe('60.00'); // debitou uma vez só
    expect(entries).toHaveLength(2);
    expect(await outboxFor(wallet.walletId)).toHaveLength(2); // sem eventos duplicados
  });

  it('replay de uma rejeição devolve a rejeição, sem novo evento', async () => {
    const wallet = await openWallet(runner, '10.00');
    const command = bet(wallet, '99.00');
    const first = await useCase.execute(command);
    const second = await useCase.execute(command);

    expect(first.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(second).toMatchObject({
      idempotentReplay: true,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      transactionId: first.transactionId,
    });
    expect(await outboxFor(wallet.walletId)).toHaveLength(1);
  });

  it('mesma chave com payload diferente: IdempotencyConflictError e nada muda', async () => {
    const wallet = await openWallet(runner, '100.00');
    const command = bet(wallet, '40.00');
    await useCase.execute(command);

    expect(
      await rejection(
        useCase.execute({
          ...command,
          money: { amount: '41.00', currency: 'BRL' },
        }),
      ),
    ).toBeInstanceOf(IdempotencyConflictError);
    expect((await snapshot(wallet.walletId)).wallet?.balance.toString()).toBe(
      '60.00',
    );
  });

  it('mesmo external id com outra chave e mesmo payload é o mesmo fato: replay', async () => {
    const wallet = await openWallet(runner, '100.00');
    const command = bet(wallet, '40.00');
    const first = await useCase.execute(command);
    const second = await useCase.execute({
      ...command,
      idempotencyKey: `outra-${randomUUID()}`,
    });

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect((await snapshot(wallet.walletId)).wallet?.balance.toString()).toBe(
      '60.00',
    );
  });

  it('a mesma chave em providers diferentes são transações independentes', async () => {
    const wallet = await openWallet(runner, '100.00');
    const command = bet(wallet, '10.00');
    await useCase.execute(command);
    const other = await useCase.execute({
      ...command,
      providerId: 'provider-b',
    });
    expect(other.idempotentReplay).toBe(false);
    expect((await snapshot(wallet.walletId)).wallet?.balance.toString()).toBe(
      '80.00',
    );
  });
});

describe('concorrência', () => {
  it('CENÁRIO OBRIGATÓRIO: saldo 100,00 e duas apostas de 80,00 simultâneas', async () => {
    const wallet = await openWallet(runner, '100.00');
    const results = await Promise.all([
      useCase.execute(bet(wallet, '80.00')),
      useCase.execute(bet(wallet, '80.00')),
    ]);

    expect(
      results.filter((r) => r.status === WagerTransactionStatus.Processed),
    ).toHaveLength(1);
    const rejected = results.filter(
      (r) => r.status === WagerTransactionStatus.Rejected,
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureCode).toBe(FailureCode.InsufficientFunds);

    const { wallet: stored, entries } = await snapshot(wallet.walletId);
    expect(stored?.balance.toString()).toBe('20.00');
    expect(
      entries.filter((entry) => entry.direction === LedgerDirection.Debit),
    ).toHaveLength(1);
  });

  it('30 envios simultâneos da MESMA aposta: um débito e 29 replays', async () => {
    const wallet = await openWallet(runner, '100.00');
    const command = bet(wallet, '10.00');
    const results = await Promise.all(
      Array.from({ length: 30 }, () => useCase.execute(command)),
    );

    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(29);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect((await snapshot(wallet.walletId)).wallet?.balance.toString()).toBe(
      '90.00',
    );
    expect(await outboxFor(wallet.walletId)).toHaveLength(2);
  });

  it('60 apostas distintas em saldo de 25,00: saldo nunca negativo e wallet == ledger', async () => {
    const wallet = await openWallet(runner, '25.00');
    const amounts = Array.from(
      { length: 60 },
      (_, index) => `${(index % 4) + 1}.50`,
    );
    const results = await Promise.all(
      amounts.map((amount) => useCase.execute(bet(wallet, amount))),
    );

    const { wallet: stored, entries } = await snapshot(wallet.walletId);
    const processed = results.filter(
      (r) => r.status === WagerTransactionStatus.Processed,
    );
    const rejected = results.filter(
      (r) => r.status === WagerTransactionStatus.Rejected,
    );
    expect(processed.length + rejected.length).toBe(60);
    expect(stored?.balance.isNegative()).toBe(false);
    expect(ledgerBalance('BRL', entries).equals(stored?.balance as never)).toBe(
      true,
    );
    // 1 lançamento por aposta aprovada (+ abertura), nenhum por rejeitada
    expect(entries).toHaveLength(processed.length + 1);
    for (const entry of entries) expect(entry.isBalanced()).toBe(true);
    // uma BET rejeitada só deveria acontecer quando realmente não cabia
    expect(stored?.version).toBe(processed.length + 1);
  });

  it('wallets diferentes não se bloqueiam (lock por walletId, não global)', async () => {
    const [a, b] = await Promise.all([
      openWallet(runner, '100.00'),
      openWallet(runner, '100.00'),
    ]);
    const results = await Promise.all([
      ...Array.from({ length: 10 }, () => useCase.execute(bet(a, '1.00'))),
      ...Array.from({ length: 10 }, () => useCase.execute(bet(b, '2.00'))),
    ]);
    expect(
      results.every((r) => r.status === WagerTransactionStatus.Processed),
    ).toBe(true);
    expect((await snapshot(a.walletId)).wallet?.balance.toString()).toBe(
      '90.00',
    );
    expect((await snapshot(b.walletId)).wallet?.balance.toString()).toBe(
      '80.00',
    );
  });
});

describe('atomicidade', () => {
  it('se gravar a outbox falha, o débito inteiro é desfeito (efeito e evento juntos)', async () => {
    const failingOutbox: OutboxRepository = {
      append: () => Promise.reject(new Error('outbox indisponível')),
    };
    const wallet = await openWallet(runner, '100.00');
    const command = bet(wallet, '30.00');

    expect(
      await rejection(buildUseCase(failingOutbox).execute(command)),
    ).toMatchObject({
      message: 'outbox indisponível',
    });

    const { wallet: stored, entries } = await snapshot(wallet.walletId);
    expect(stored?.balance.toString()).toBe('100.00');
    expect(stored?.version).toBe(1);
    expect(entries).toHaveLength(1);
    const found = await runner.read((db) =>
      transactions.findByExternalId(
        db,
        command.providerId,
        command.externalTransactionId,
      ),
    );
    expect(found).toBeUndefined(); // nem a transação ficou registrada

    // e o reenvio da mesma aposta funciona normalmente depois
    const retry = await useCase.execute(command);
    expect(retry.status).toBe(WagerTransactionStatus.Processed);
    expect(retry.idempotentReplay).toBe(false);
  });
});
