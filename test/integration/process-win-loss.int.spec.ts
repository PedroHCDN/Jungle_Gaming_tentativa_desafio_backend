import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { IdempotencyConflictError } from '../../src/application/errors';
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
import { SystemClock } from '../../src/infrastructure/runtime/system-clock';
import { UuidGenerator } from '../../src/infrastructure/runtime/uuid-generator';
import { BunTransactionRunner } from './support/bun-transaction-runner';
import { createTestDatabase, type TestDatabase } from './support/test-database';
import { openWallet } from './support/wallet-fixtures';

/** WIN e LOSS contra PostgreSQL real: crédito, referência opcional a um BET e idempotência. */

const wallets = new SqlWalletRepository();
const transactions = new SqlWagerTransactionRepository();
const ledger = new SqlLedgerRepository();

let database: TestDatabase;
let runner: BunTransactionRunner;
let useCase: ProcessWagerTransactionUseCase;

beforeAll(async () => {
  database = await createTestDatabase();
  runner = new BunTransactionRunner(database.sql);
  useCase = new ProcessWagerTransactionUseCase({
    runner,
    wallets,
    transactions,
    ledger,
    inbox: new SqlInboxRepository(),
    outbox: new SqlOutboxRepository(),
    clock: new SystemClock(),
    ids: new UuidGenerator(),
  });
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
  overrides: Partial<ProcessWagerTransactionCommand> = {},
) => command(owner, WagerTransactionKind.Bet, amount, overrides);
const win = (
  owner: Owner,
  amount: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
) => command(owner, WagerTransactionKind.Win, amount, overrides);
const loss = (
  owner: Owner,
  amount: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
) => command(owner, WagerTransactionKind.Loss, amount, overrides);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

async function snapshot(walletId: string) {
  return runner.read(async (db) => ({
    wallet: await wallets.findById(db, walletId),
    entries: await ledger.findByWalletId(db, walletId),
  }));
}

interface OutboxRow {
  event_type: string;
  payload: { data: Record<string, unknown> };
}

async function outboxFor(walletId: string): Promise<OutboxRow[]> {
  const rows: unknown = await database.sql.unsafe(
    `SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = $1 ORDER BY seq`,
    [walletId],
  );
  return rows as OutboxRow[];
}

const storedTransaction = (command: ProcessWagerTransactionCommand) =>
  runner.read((db) =>
    transactions.findByExternalId(
      db,
      command.providerId,
      command.externalTransactionId,
    ),
  );

describe('WIN sem referência', () => {
  it('credita o saldo, grava lançamento CREDIT e os eventos na outbox', async () => {
    const owner = await openWallet(runner, '100.00');
    const result = await useCase.execute(win(owner, '45.50'));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.walletBalance).toEqual({ amount: '145.50', currency: 'BRL' });

    const { wallet, entries } = await snapshot(owner.walletId);
    expect(wallet?.balance.toString()).toBe('145.50');
    expect(wallet?.version).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries[1]?.direction).toBe(LedgerDirection.Credit);
    expect(entries[1]?.balanceBefore.toString()).toBe('100.00');
    expect(entries[1]?.balanceAfter.toString()).toBe('145.50');

    const events = await outboxFor(owner.walletId);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(events[1]?.payload.data['direction']).toBe('CREDIT');
  });

  it('não perde centavos ao somar valores quebrados', async () => {
    const owner = await openWallet(runner, '0.10');
    await useCase.execute(win(owner, '0.20'));
    expect((await snapshot(owner.walletId)).wallet?.balance.toString()).toBe(
      '0.30',
    );
  });
});

describe('WIN com referência a um BET', () => {
  async function processedBet(
    owner: Owner,
    overrides: Partial<ProcessWagerTransactionCommand> = {},
  ) {
    const betCommand = bet(owner, '20.00', overrides);
    const result = await useCase.execute(betCommand);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    return { betCommand, betId: result.transactionId };
  }

  it('liga o WIN ao BET: guarda a referência resolvida e o banco aceita o lançamento', async () => {
    const owner = await openWallet(runner, '100.00');
    const { betCommand, betId } = await processedBet(owner);
    const winCommand = win(owner, '50.00', {
      referenceExternalTransactionId: betCommand.externalTransactionId,
    });

    const result = await useCase.execute(winCommand);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.walletBalance.amount).toBe('130.00'); // 100 - 20 + 50

    const stored = await storedTransaction(winCommand);
    expect(stored?.referenceTransactionId).toBe(betId);
    expect(stored?.referenceExternalTransactionId).toBe(
      betCommand.externalTransactionId,
    );
  });

  it('o valor do WIN não precisa ser igual ao do BET', async () => {
    const owner = await openWallet(runner, '100.00');
    const { betCommand } = await processedBet(owner);
    const result = await useCase.execute(
      win(owner, '1.00', {
        referenceExternalTransactionId: betCommand.externalTransactionId,
      }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Processed);
  });

  it('rodada diferente: REJECTED/REFERENCE_MISMATCH, sem mexer no saldo', async () => {
    const owner = await openWallet(runner, '100.00');
    const { betCommand } = await processedBet(owner);
    const result = await useCase.execute(
      win(owner, '50.00', {
        roundId: 'round-2',
        referenceExternalTransactionId: betCommand.externalTransactionId,
      }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect((await snapshot(owner.walletId)).wallet?.balance.toString()).toBe(
      '80.00',
    );
  });

  it('referência que é outro WIN: REJECTED/INVALID_REFERENCE_KIND', async () => {
    const owner = await openWallet(runner, '100.00');
    const firstWin = win(owner, '10.00');
    await useCase.execute(firstWin);
    const result = await useCase.execute(
      win(owner, '10.00', {
        referenceExternalTransactionId: firstWin.externalTransactionId,
      }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InvalidReferenceKind);
    expect((await snapshot(owner.walletId)).wallet?.balance.toString()).toBe(
      '110.00',
    );
  });

  it('BET que foi rejeitado: WIN vira REJECTED/REFERENCE_NOT_PROCESSED', async () => {
    const owner = await openWallet(runner, '10.00');
    const rejectedBet = bet(owner, '50.00'); // sem saldo
    expect((await useCase.execute(rejectedBet)).failureCode).toBe(
      FailureCode.InsufficientFunds,
    );

    const result = await useCase.execute(
      win(owner, '30.00', {
        referenceExternalTransactionId: rejectedBet.externalTransactionId,
      }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect((await snapshot(owner.walletId)).wallet?.balance.toString()).toBe(
      '10.00',
    );
  });

  it('referência ainda inexistente: fica PENDING_REFERENCE, sem tocar no saldo', async () => {
    const owner = await openWallet(runner, '100.00');
    const winCommand = win(owner, '50.00', {
      referenceExternalTransactionId: 'bet-que-ainda-nao-chegou',
    });

    const result = await useCase.execute(winCommand);
    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(result.walletBalance.amount).toBe('100.00');

    const stored = await storedTransaction(winCommand);
    expect(stored?.referenceAttempts).toBe(1);
    expect(stored?.nextAttemptAt).toBeInstanceOf(Date);
    expect(stored?.referenceTransactionId).toBeUndefined();
    expect((await snapshot(owner.walletId)).entries).toHaveLength(1);
  });

  it('a referência é resolvida só dentro do mesmo provider', async () => {
    const owner = await openWallet(runner, '100.00');
    const { betCommand } = await processedBet(owner);
    // o BET existe, mas no provider-a: para o provider-b a referência não existe
    const result = await useCase.execute(
      win(owner, '5.00', {
        providerId: 'provider-b',
        referenceExternalTransactionId: betCommand.externalTransactionId,
      }),
    );
    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
  });
});

describe('LOSS', () => {
  it('valor zero: PROCESSED, sem lançamento, saldo e versão intactos, só o evento Processed', async () => {
    const owner = await openWallet(runner, '100.00');
    const lossCommand = loss(owner, '0.00');
    const result = await useCase.execute(lossCommand);

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.walletBalance.amount).toBe('100.00');

    const { wallet, entries } = await snapshot(owner.walletId);
    expect(wallet?.balance.toString()).toBe('100.00');
    expect(wallet?.version).toBe(1);
    expect(entries).toHaveLength(1); // só a abertura

    expect(
      (await outboxFor(owner.walletId)).map((event) => event.event_type),
    ).toEqual(['WagerTransactionProcessed']);
    const stored = await storedTransaction(lossCommand);
    expect(stored?.status).toBe(WagerTransactionStatus.Processed);
    expect(stored?.processedAt).toBeInstanceOf(Date);
  });

  it('valor positivo (a aposta perdida) também não mexe no saldo', async () => {
    const owner = await openWallet(runner, '100.00');
    const betCommand = bet(owner, '30.00');
    await useCase.execute(betCommand);
    const result = await useCase.execute(
      loss(owner, '30.00', {
        referenceExternalTransactionId: betCommand.externalTransactionId,
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    const { wallet, entries } = await snapshot(owner.walletId);
    expect(wallet?.balance.toString()).toBe('70.00'); // só o débito do BET
    expect(entries).toHaveLength(2);
  });

  it('referência a BET rejeitado: REJECTED/REFERENCE_NOT_PROCESSED', async () => {
    const owner = await openWallet(runner, '5.00');
    const rejectedBet = bet(owner, '50.00');
    await useCase.execute(rejectedBet);
    const result = await useCase.execute(
      loss(owner, '50.00', {
        referenceExternalTransactionId: rejectedBet.externalTransactionId,
      }),
    );
    expect(result.failureCode).toBe(FailureCode.ReferenceNotProcessed);
  });

  it('moeda diferente da wallet: REJECTED/CURRENCY_MISMATCH', async () => {
    const owner = await openWallet(runner, '100.00');
    const result = await useCase.execute(
      loss(owner, '0.00', { money: { amount: '0.00', currency: 'USD' } }),
    );
    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  it('replay: um único registro e um único evento', async () => {
    const owner = await openWallet(runner, '100.00');
    const lossCommand = loss(owner, '0.00');
    const first = await useCase.execute(lossCommand);
    const second = await useCase.execute(lossCommand);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await outboxFor(owner.walletId)).toHaveLength(1);
  });
});

describe('idempotência e concorrência de WIN', () => {
  it('replay do mesmo WIN credita uma vez só', async () => {
    const owner = await openWallet(runner, '100.00');
    const winCommand = win(owner, '25.00');
    const first = await useCase.execute(winCommand);
    const second = await useCase.execute(winCommand);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect((await snapshot(owner.walletId)).wallet?.balance.toString()).toBe(
      '125.00',
    );
    expect(await outboxFor(owner.walletId)).toHaveLength(2);
  });

  it('mesma chave com payload diferente: IdempotencyConflictError e nada muda', async () => {
    const owner = await openWallet(runner, '100.00');
    const winCommand = win(owner, '25.00');
    await useCase.execute(winCommand);
    const error = await rejection(
      useCase.execute({
        ...winCommand,
        money: { amount: '26.00', currency: 'BRL' },
      }),
    );
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((await snapshot(owner.walletId)).wallet?.balance.toString()).toBe(
      '125.00',
    );
  });

  it('20 envios simultâneos do MESMO WIN: um crédito e 19 replays', async () => {
    const owner = await openWallet(runner, '100.00');
    const winCommand = win(owner, '10.00');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => useCase.execute(winCommand)),
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
      1,
    );
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect((await snapshot(owner.walletId)).wallet?.balance.toString()).toBe(
      '110.00',
    );
  });

  it('BETs, WINs e LOSSes misturados em paralelo: saldo nunca negativo e wallet == ledger', async () => {
    const owner = await openWallet(runner, '10.00');
    const commands = [
      ...Array.from({ length: 25 }, () => bet(owner, '5.00')),
      ...Array.from({ length: 25 }, () => win(owner, '3.25')),
      ...Array.from({ length: 10 }, () => loss(owner, '0.00')),
    ];
    // embaralha: a ordem de chegada não pode importar para o invariante
    commands.sort(() => Math.random() - 0.5);
    const results = await Promise.all(
      commands.map((item) => useCase.execute(item)),
    );

    const { wallet, entries } = await snapshot(owner.walletId);
    const processedBets = results.filter(
      (result, index) =>
        commands[index]?.kind === WagerTransactionKind.Bet &&
        result.status === WagerTransactionStatus.Processed,
    ).length;

    expect(wallet?.balance.isNegative()).toBe(false);
    expect(ledgerBalance('BRL', entries).equals(wallet?.balance as never)).toBe(
      true,
    );
    // todo WIN é aprovado; cada LOSS não gera lançamento
    expect(entries).toHaveLength(1 + processedBets + 25);
    for (const entry of entries) expect(entry.isBalanced()).toBe(true);
    // saldo final = 10 - 5 * BETs aprovadas + 3.25 * 25 (centavos exatos)
    const expectedCents = 1000 - 500 * processedBets + 325 * 25;
    expect(wallet?.balance.toString()).toBe(
      `${Math.trunc(expectedCents / 100)}.${String(expectedCents % 100).padStart(2, '0')}`,
    );
  });
});
