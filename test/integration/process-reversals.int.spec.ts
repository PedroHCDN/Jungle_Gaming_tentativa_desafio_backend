import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { OutboxRepository } from '../../src/application/ports/persistence';
import type { Clock } from '../../src/application/ports/runtime';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/application/process-wager-transaction/process-wager-transaction.use-case';
import { ledgerBalance } from '../../src/domain/ledger/ledger-balance';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
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
import { UuidGenerator } from '../../src/infrastructure/runtime/uuid-generator';
import { BunTransactionRunner } from './support/bun-transaction-runner';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { openWallet } from './support/wallet-fixtures';

/**
 * REFUND, ROLLBACK e PENDING_REFERENCE contra PostgreSQL real. O relógio é
 * falso: o backoff (1 s, 2 s, 4 s, 8 s) é verificado sem esperar de verdade.
 */

const Kind = WagerTransactionKind;
const Status = WagerTransactionStatus;

class FakeClock implements Clock {
  private current = new Date();
  readonly start = this.current.getTime();

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const wallets = new SqlWalletRepository();
const transactions = new SqlWagerTransactionRepository();
const ledger = new SqlLedgerRepository();

let database: TestDatabase;
let runner: BunTransactionRunner;
let clock: FakeClock;
let useCase: ProcessWagerTransactionUseCase;

function buildUseCase(outbox: OutboxRepository = new SqlOutboxRepository()) {
  return new ProcessWagerTransactionUseCase({
    runner,
    wallets,
    transactions,
    ledger,
    inbox: new SqlInboxRepository(),
    outbox,
    clock,
    ids: new UuidGenerator(),
  });
}

beforeAll(async () => {
  database = await createTestDatabase();
  runner = new BunTransactionRunner(database.sql);
  clock = new FakeClock();
  useCase = buildUseCase();
});

afterAll(async () => {
  await database.close();
});

interface Owner {
  walletId: string;
  playerId: string;
}

function command(
  owner: Owner,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const id = randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId: `${kind.toLowerCase()}-${id}`,
    idempotencyKey: `key-${id}`,
    walletId: owner.walletId,
    playerId: owner.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

const bet = (
  owner: Owner,
  amount: string,
  o: Partial<ProcessWagerTransactionCommand> = {},
) => command(owner, Kind.Bet, amount, o);
const win = (
  owner: Owner,
  amount: string,
  o: Partial<ProcessWagerTransactionCommand> = {},
) => command(owner, Kind.Win, amount, o);
const loss = (
  owner: Owner,
  amount: string,
  o: Partial<ProcessWagerTransactionCommand> = {},
) => command(owner, Kind.Loss, amount, o);
const refund = (
  owner: Owner,
  amount: string,
  of: ProcessWagerTransactionCommand,
) =>
  command(owner, Kind.Refund, amount, {
    referenceExternalTransactionId: of.externalTransactionId,
  });
const rollback = (
  owner: Owner,
  amount: string,
  of: ProcessWagerTransactionCommand,
) =>
  command(owner, Kind.Rollback, amount, {
    referenceExternalTransactionId: of.externalTransactionId,
  });

async function run(item: ProcessWagerTransactionCommand) {
  const result = await useCase.execute(item);
  return result;
}

async function snapshot(walletId: string) {
  return runner.read(async (db) => ({
    wallet: await wallets.findById(db, walletId),
    entries: await ledger.findByWalletId(db, walletId),
  }));
}

const balanceOf = async (owner: Owner) =>
  (await snapshot(owner.walletId)).wallet?.balance.toString();

const stored = (item: ProcessWagerTransactionCommand) =>
  runner.read((db) =>
    transactions.findByExternalId(
      db,
      item.providerId,
      item.externalTransactionId,
    ),
  );

async function eventTypes(walletId: string): Promise<string[]> {
  const rows: unknown = await database.sql.unsafe(
    `SELECT event_type FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq`,
    [walletId],
  );
  return (rows as { event_type: string }[]).map((row) => row.event_type);
}

/** A BET de `amount` já PROCESSADA numa wallet nova com 100,00. */
async function walletWithBet(amount = '30.00') {
  const owner = await openWallet(runner, '100.00');
  const betCommand = bet(owner, amount);
  const result = await run(betCommand);
  expect(result.status).toBe(Status.Processed);
  return { owner, betCommand, betId: result.transactionId };
}

describe('REFUND e ROLLBACK aprovados', () => {
  it('REFUND de um BET devolve o valor, liga a referência e emite os eventos', async () => {
    const { owner, betCommand, betId } = await walletWithBet('30.00');
    const refundCommand = refund(owner, '30.00', betCommand);
    const result = await run(refundCommand);

    expect(result.status).toBe(Status.Processed);
    expect(result.walletBalance.amount).toBe('100.00');
    const { entries } = await snapshot(owner.walletId);
    expect(entries.at(-1)?.direction).toBe(LedgerDirection.Credit);
    expect((await stored(refundCommand))?.referenceTransactionId).toBe(betId);
    expect((await eventTypes(owner.walletId)).slice(-2)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('ROLLBACK de um BET devolve o valor (inverso do débito)', async () => {
    const { owner, betCommand } = await walletWithBet('30.00');
    const result = await run(rollback(owner, '30.00', betCommand));
    expect(result.status).toBe(Status.Processed);
    expect(await balanceOf(owner)).toBe('100.00');
    expect((await snapshot(owner.walletId)).entries.at(-1)?.direction).toBe(
      LedgerDirection.Credit,
    );
  });

  it('ROLLBACK de um WIN debita o valor (inverso do crédito)', async () => {
    const owner = await openWallet(runner, '100.00');
    const winCommand = win(owner, '40.00');
    await run(winCommand);
    expect(await balanceOf(owner)).toBe('140.00');

    const result = await run(rollback(owner, '40.00', winCommand));
    expect(result.status).toBe(Status.Processed);
    expect(await balanceOf(owner)).toBe('100.00');
    expect((await snapshot(owner.walletId)).entries.at(-1)?.direction).toBe(
      LedgerDirection.Debit,
    );
  });

  it('ROLLBACK de um REFUND debita o valor de novo', async () => {
    const { owner, betCommand } = await walletWithBet('30.00');
    const refundCommand = refund(owner, '30.00', betCommand);
    await run(refundCommand);
    expect(await balanceOf(owner)).toBe('100.00');

    const result = await run(rollback(owner, '30.00', refundCommand));
    expect(result.status).toBe(Status.Processed);
    expect(await balanceOf(owner)).toBe('70.00');
  });

  it('o replay de uma reversão credita uma vez só', async () => {
    const { owner, betCommand } = await walletWithBet('30.00');
    const refundCommand = refund(owner, '30.00', betCommand);
    const first = await run(refundCommand);
    const second = await run(refundCommand);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await balanceOf(owner)).toBe('100.00');
  });
});

describe('REFUND e ROLLBACK rejeitados', () => {
  it('REFUND de um WIN: INVALID_REFERENCE_KIND', async () => {
    const owner = await openWallet(runner, '100.00');
    const winCommand = win(owner, '10.00');
    await run(winCommand);
    const result = await run(refund(owner, '10.00', winCommand));
    expect(result.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect(await balanceOf(owner)).toBe('110.00');
  });

  it('REFUND e ROLLBACK de um LOSS: INVALID_REFERENCE_KIND', async () => {
    const owner = await openWallet(runner, '100.00');
    const lossCommand = loss(owner, '0.00');
    await run(lossCommand);
    // valores diferentes de zero: a regra de tipo vem antes da de valor
    expect((await run(refund(owner, '5.00', lossCommand))).failureCode).toBe(
      FailureCode.InvalidReferenceKind,
    );
    expect((await run(rollback(owner, '5.00', lossCommand))).failureCode).toBe(
      FailureCode.InvalidReferenceKind,
    );
  });

  it('valor diferente do original: AMOUNT_MISMATCH (sem reversão parcial)', async () => {
    const { owner, betCommand } = await walletWithBet('30.00');
    const result = await run(refund(owner, '20.00', betCommand));
    expect(result.failureCode).toBe(FailureCode.AmountMismatch);
    expect(await balanceOf(owner)).toBe('70.00');
  });

  it('rodada diferente: REFERENCE_MISMATCH', async () => {
    const { owner, betCommand } = await walletWithBet('30.00');
    const result = await run({
      ...refund(owner, '30.00', betCommand),
      roundId: 'round-2',
    });
    expect(result.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  it('BET que foi rejeitado: REFERENCE_NOT_PROCESSED', async () => {
    const owner = await openWallet(runner, '10.00');
    const rejectedBet = bet(owner, '50.00');
    await run(rejectedBet);
    const result = await run(refund(owner, '50.00', rejectedBet));
    expect(result.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(await balanceOf(owner)).toBe('10.00');
  });

  it('só uma reversão por referência: REFUND repetido e ROLLBACK depois de REFUND', async () => {
    const { owner, betCommand } = await walletWithBet('30.00');
    expect((await run(refund(owner, '30.00', betCommand))).status).toBe(
      Status.Processed,
    );

    const secondRefund = await run(refund(owner, '30.00', betCommand));
    const rollbackAfter = await run(rollback(owner, '30.00', betCommand));
    expect(secondRefund.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(rollbackAfter.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(await balanceOf(owner)).toBe('100.00'); // devolveu uma vez só
  });

  it('ROLLBACK que deixaria o saldo negativo: REVERSAL_WOULD_OVERDRAW (não INSUFFICIENT_FUNDS)', async () => {
    const owner = await openWallet(runner, '100.00');
    const winCommand = win(owner, '50.00');
    await run(winCommand); // 150
    await run(bet(owner, '150.00')); // 0

    const result = await run(rollback(owner, '50.00', winCommand));
    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(await balanceOf(owner)).toBe('0.00');
  });
});

describe('concorrência nas reversões', () => {
  it('REFUND e ROLLBACK simultâneos do mesmo BET: só um é aplicado', async () => {
    const { owner, betCommand } = await walletWithBet('30.00');
    const results = await Promise.all([
      run(refund(owner, '30.00', betCommand)),
      run(rollback(owner, '30.00', betCommand)),
    ]);

    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(
      1,
    );
    const rejected = results.filter((r) => r.status === Status.Rejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(await balanceOf(owner)).toBe('100.00');
  });

  it('15 REFUNDs distintos simultâneos do mesmo BET: um crédito só', async () => {
    const { owner, betCommand } = await walletWithBet('30.00');
    const results = await Promise.all(
      Array.from({ length: 15 }, () => run(refund(owner, '30.00', betCommand))),
    );

    expect(results.filter((r) => r.status === Status.Processed)).toHaveLength(
      1,
    );
    expect(
      results.filter((r) => r.failureCode === FailureCode.AlreadyReversed),
    ).toHaveLength(14);
    const { wallet, entries } = await snapshot(owner.walletId);
    expect(wallet?.balance.toString()).toBe('100.00');
    expect(ledgerBalance('BRL', entries).equals(wallet?.balance as never)).toBe(
      true,
    );
  });
});

describe('PENDING_REFERENCE: referência fora de ordem', () => {
  it('REFUND antes do BET: fica pendente (1 s), sem tocar no saldo, e o replay não gasta tentativa', async () => {
    const owner = await openWallet(runner, '100.00');
    const betCommand = bet(owner, '30.00'); // ainda não enviado
    const refundCommand = refund(owner, '30.00', betCommand);
    const sentAt = clock.now().getTime();

    const result = await run(refundCommand);
    expect(result.status).toBe(Status.PendingReference);
    expect(result.walletBalance.amount).toBe('100.00');

    const pending = await stored(refundCommand);
    expect(pending?.referenceAttempts).toBe(1);
    expect(pending?.nextAttemptAt?.getTime()).toBe(sentAt + 1000);
    expect(pending?.referenceTransactionId).toBeUndefined();
    expect((await snapshot(owner.walletId)).entries).toHaveLength(1);
    expect(await eventTypes(owner.walletId)).toEqual([
      'WagerTransactionPendingReference',
    ]);

    const replay = await run(refundCommand);
    expect(replay).toMatchObject({
      idempotentReplay: true,
      status: Status.PendingReference,
    });
    expect((await stored(refundCommand))?.referenceAttempts).toBe(1);
    expect(await eventTypes(owner.walletId)).toHaveLength(1);
  });

  it('a referência chega e o reprocessamento (só depois do prazo) conclui a reversão', async () => {
    const owner = await openWallet(runner, '100.00');
    const betCommand = bet(owner, '30.00');
    const refundCommand = refund(owner, '30.00', betCommand);
    const pending = await run(refundCommand);

    const betResult = await run(betCommand); // chega atrasado
    expect(betResult.status).toBe(Status.Processed);
    expect(await balanceOf(owner)).toBe('70.00');

    // ainda não está na hora: nada acontece e a tentativa não é gasta
    expect(
      await useCase.retryPendingReference(pending.transactionId),
    ).toBeUndefined();
    expect((await stored(refundCommand))?.referenceAttempts).toBe(1);

    clock.advance(1000);
    const retried = await useCase.retryPendingReference(pending.transactionId);
    expect(retried).toMatchObject({
      status: Status.Processed,
      idempotentReplay: false,
    });
    expect(retried?.walletBalance.amount).toBe('100.00');

    const done = await stored(refundCommand);
    expect(done?.status).toBe(Status.Processed);
    expect(done?.nextAttemptAt).toBeUndefined(); // o banco exige: só PENDING_REFERENCE tem
    expect(done?.referenceTransactionId).toBe(betResult.transactionId);
    expect(await eventTypes(owner.walletId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed', // BET
      'WalletBalanceChanged',
      'WagerTransactionProcessed', // REFUND
      'WalletBalanceChanged',
    ]);
  });

  it('WIN também espera pelo seu BET', async () => {
    const owner = await openWallet(runner, '100.00');
    const betCommand = bet(owner, '20.00');
    const winCommand = win(owner, '50.00', {
      referenceExternalTransactionId: betCommand.externalTransactionId,
    });
    const pending = await run(winCommand);
    expect(pending.status).toBe(Status.PendingReference);

    await run(betCommand);
    clock.advance(1000);
    const retried = await useCase.retryPendingReference(pending.transactionId);
    expect(retried?.status).toBe(Status.Processed);
    expect(await balanceOf(owner)).toBe('130.00'); // 100 - 20 + 50
  });

  it('backoff 1 s, 2 s, 4 s, 8 s e, na 5ª busca sem achar, REJECTED/REFERENCE_NOT_FOUND', async () => {
    const owner = await openWallet(runner, '100.00');
    const refundCommand = refund(owner, '30.00', bet(owner, '30.00')); // o BET nunca chega
    const pending = await run(refundCommand);

    const waits: number[] = [];
    const record = async () => {
      const row = await stored(refundCommand);
      waits.push((row?.nextAttemptAt?.getTime() ?? 0) - clock.now().getTime());
    };
    await record(); // espera depois da 1ª busca

    for (const delay of [1000, 2000, 4000]) {
      clock.advance(delay);
      const retried = await useCase.retryPendingReference(
        pending.transactionId,
      );
      expect(retried?.status).toBe(Status.PendingReference);
      await record();
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000]);

    clock.advance(8000);
    const last = await useCase.retryPendingReference(pending.transactionId);
    expect(last).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });

    const final = await stored(refundCommand);
    expect(final?.status).toBe(Status.Rejected);
    expect(final?.nextAttemptAt).toBeUndefined();
    expect(await balanceOf(owner)).toBe('100.00');
    expect(await eventTypes(owner.walletId)).toEqual([
      'WagerTransactionPendingReference', // só uma vez, na primeira espera
      'WagerTransactionRejected',
    ]);

    // já terminal: reprocessar de novo não faz nada
    expect(
      await useCase.retryPendingReference(pending.transactionId),
    ).toBeUndefined();
  });

  it('a referência chega, mas foi rejeitada: REJECTED/REFERENCE_NOT_PROCESSED', async () => {
    const owner = await openWallet(runner, '10.00');
    const betCommand = bet(owner, '50.00'); // vai ser rejeitado por falta de saldo
    const pending = await run(refund(owner, '50.00', betCommand));
    expect((await run(betCommand)).failureCode).toBe(
      FailureCode.InsufficientFunds,
    );

    clock.advance(1000);
    const retried = await useCase.retryPendingReference(pending.transactionId);
    expect(retried).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceNotProcessed,
    });
    expect(await balanceOf(owner)).toBe('10.00');
  });

  it('ROLLBACK de um REFUND que também está pendente espera, e a cadeia se resolve na ordem', async () => {
    const owner = await openWallet(runner, '100.00');
    const betCommand = bet(owner, '30.00');
    const refundCommand = refund(owner, '30.00', betCommand);
    const rollbackCommand = rollback(owner, '30.00', refundCommand);

    const pendingRefund = await run(refundCommand);
    const pendingRollback = await run(rollbackCommand);
    expect(pendingRefund.status).toBe(Status.PendingReference);
    expect(pendingRollback.status).toBe(Status.PendingReference); // o REFUND existe, mas pendente

    await run(betCommand); // 70
    clock.advance(1000);
    expect(
      (await useCase.retryPendingReference(pendingRefund.transactionId))
        ?.status,
    ).toBe(Status.Processed); // 100
    clock.advance(2000);
    expect(
      (await useCase.retryPendingReference(pendingRollback.transactionId))
        ?.status,
    ).toBe(Status.Processed); // 70
    expect(await balanceOf(owner)).toBe('70.00');
  });

  it('dois reprocessamentos simultâneos da mesma pendência: um aplica, o outro não faz nada', async () => {
    const owner = await openWallet(runner, '100.00');
    const betCommand = bet(owner, '30.00');
    const pending = await run(refund(owner, '30.00', betCommand));
    await run(betCommand);
    clock.advance(1000);

    const results = await Promise.all([
      useCase.retryPendingReference(pending.transactionId),
      useCase.retryPendingReference(pending.transactionId),
    ]);
    expect(results.filter((r) => r?.status === Status.Processed)).toHaveLength(
      1,
    );
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    expect(await balanceOf(owner)).toBe('100.00'); // devolveu uma vez só
  });

  it('retry de uma transação inexistente não faz nada', async () => {
    expect(await useCase.retryPendingReference(randomUUID())).toBeUndefined();
  });

  it('se a outbox falha no reprocessamento, nada muda e o retry seguinte funciona', async () => {
    const owner = await openWallet(runner, '100.00');
    const betCommand = bet(owner, '30.00');
    const refundCommand = refund(owner, '30.00', betCommand);
    const pending = await run(refundCommand);
    await run(betCommand);
    clock.advance(1000);

    const failing = buildUseCase({
      append: () => Promise.reject(new Error('outbox indisponível')),
    });
    let failure: unknown;
    try {
      await failing.retryPendingReference(pending.transactionId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ message: 'outbox indisponível' });

    const still = await stored(refundCommand);
    expect(still?.status).toBe(Status.PendingReference);
    expect(still?.referenceAttempts).toBe(1);
    expect(await balanceOf(owner)).toBe('70.00'); // nada foi devolvido

    const retried = await useCase.retryPendingReference(pending.transactionId);
    expect(retried?.status).toBe(Status.Processed);
    expect(await balanceOf(owner)).toBe('100.00');
  });
});
