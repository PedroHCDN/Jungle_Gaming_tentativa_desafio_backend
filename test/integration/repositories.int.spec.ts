import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  StaleWalletError,
  type DbSession,
} from '../../src/application/ports/persistence';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import { ledgerBalance } from '../../src/domain/ledger/ledger-balance';
import { WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { InsufficientFundsError } from '../../src/domain/shared/domain-error';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { SqlLedgerRepository } from '../../src/infrastructure/persistence/repositories/ledger.repository';
import { SqlWagerTransactionRepository } from '../../src/infrastructure/persistence/repositories/wager-transaction.repository';
import { SqlWalletRepository } from '../../src/infrastructure/persistence/repositories/wallet.repository';
import { BunTransactionRunner } from './support/bun-transaction-runner';
import { createTestDatabase, type TestDatabase } from './support/test-database';

/**
 * Os repositories de produção contra PostgreSQL real: locking, idempotência e
 * o invariante `wallet.balance == ledger` sob concorrência.
 */

const wallets = new SqlWalletRepository();
const transactions = new SqlWagerTransactionRepository();
const ledger = new SqlLedgerRepository();
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

let database: TestDatabase;
let runner: BunTransactionRunner;

beforeAll(async () => {
  database = await createTestDatabase();
  runner = new BunTransactionRunner(database.sql);
});

afterAll(async () => {
  await database.close();
});

/** Abre uma wallet com saldo: wallet + OPENING + lançamento, numa transação. */
async function openWallet(initial: string): Promise<string> {
  const now = new Date();
  const wallet = Wallet.open({
    id: randomUUID(),
    playerId: `player-${randomUUID()}`,
    initialBalance: brl(initial),
    now,
  });
  await runner.run(async (db) => {
    await wallets.insert(db, wallet);
    const opening = WagerTransaction.createOpening({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: wallet.balance,
      now,
    });
    await transactions.insertIfAbsent(db, opening);
    await ledger.append(
      db,
      WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: wallet.balance,
        balanceBefore: Money.zero('BRL'),
        balanceAfter: wallet.balance,
        createdAt: now,
      }),
    );
    opening.markProcessed(undefined, now);
    await transactions.saveTransition(db, opening);
  });
  return wallet.id;
}

type Outcome = 'PROCESSED' | 'REJECTED' | 'DUPLICATE';

/**
 * Protótipo do caso de uso de BET, só para provar os repositories:
 * insere a transação (idempotente), TRAVA a wallet, debita, grava ledger +
 * saldo e conclui — tudo em uma transação SQL.
 */
async function placeBet(
  walletId: string,
  amount: string,
  externalId: string,
  afterLock?: () => Promise<void>,
): Promise<Outcome> {
  const money = brl(amount);
  const now = new Date();
  return runner.run(async (db: DbSession) => {
    const bet = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: externalId,
      idempotencyKey: externalId,
      walletId,
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money,
      now,
    });
    if (!(await transactions.insertIfAbsent(db, bet))) return 'DUPLICATE';

    const wallet = await wallets.findByIdForUpdate(db, walletId);
    if (wallet === undefined) throw new Error('wallet not found');
    await afterLock?.();

    let movement;
    try {
      movement = wallet.debit(money, now);
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) throw error;
      bet.reject(FailureCode.InsufficientFunds);
      await transactions.saveTransition(db, bet);
      return 'REJECTED';
    }
    await ledger.append(
      db,
      WalletLedgerEntry.fromMovement(movement, {
        id: randomUUID(),
        walletId,
        transactionId: bet.id,
        createdAt: now,
      }),
    );
    await wallets.saveMovement(db, wallet);
    bet.markProcessed(undefined, now);
    await transactions.saveTransition(db, bet);
    return 'PROCESSED';
  });
}

const readWallet = async (id: string) =>
  runner
    .read((db) => wallets.findById(db, id))
    .then((wallet) => wallet as Wallet);

describe('SqlWalletRepository', () => {
  it('faz round-trip exato do saldo (sem perder centavos)', async () => {
    const id = await openWallet('99999999999999.99');
    const wallet = await readWallet(id);
    expect(wallet.balance.toString()).toBe('99999999999999.99');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
  });

  it('devolve undefined para wallet inexistente', async () => {
    expect(
      await runner.read((db) => wallets.findById(db, randomUUID())),
    ).toBeUndefined();
  });

  it('saveMovement com versão desatualizada lança StaleWalletError', async () => {
    const id = await openWallet('100.00');
    const stale = await readWallet(id); // versão 1
    expect(await placeBet(id, '10.00', `bet-${randomUUID()}`)).toBe(
      'PROCESSED',
    ); // banco vai a 2

    stale.debit(brl('5.00'), new Date()); // versão 2 (local), mas o banco já está em 2
    await Promise.resolve(
      expect(
        runner.run((db) => wallets.saveMovement(db, stale)),
      ).rejects.toBeInstanceOf(StaleWalletError),
    );
    expect((await readWallet(id)).balance.toString()).toBe('90.00');
  });

  it('rollback desfaz tudo quando a transação falha no meio', async () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: 'p-rollback',
      initialBalance: brl('0.00'),
    });
    await Promise.resolve(
      expect(
        runner.run(async (db) => {
          await wallets.insert(db, wallet);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom'),
    );
    expect(
      await runner.read((db) => wallets.findById(db, wallet.id)),
    ).toBeUndefined();
  });
});

describe('lock-first: SELECT … FOR NO KEY UPDATE', () => {
  it('uma segunda transação espera a primeira e enxerga o saldo já atualizado', async () => {
    const id = await openWallet('100.00');
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = placeBet(id, '30.00', `bet-${randomUUID()}`, async () => {
      events.push('first locked');
      await gate;
    });
    while (!events.includes('first locked')) await sleep(10);

    const second = runner.run(async (db) => {
      const wallet = await wallets.findByIdForUpdate(db, id);
      events.push(`second locked at ${wallet?.balance.toString()}`);
    });

    await sleep(300);
    expect(events).toEqual(['first locked']); // segunda continua bloqueada
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first locked', 'second locked at 70.00']);
  });
});

describe('concorrência: o invariante wallet == ledger se mantém', () => {
  it('25 apostas de 1.00 em 10.00 de saldo: exatamente 10 passam, 15 são rejeitadas', async () => {
    const id = await openWallet('10.00');
    const outcomes = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        placeBet(id, '1.00', `bet-${id}-${index}`),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'PROCESSED')).toHaveLength(
      10,
    );
    expect(outcomes.filter((outcome) => outcome === 'REJECTED')).toHaveLength(
      15,
    );

    const wallet = await readWallet(id);
    const entries = await runner.read((db) => ledger.findByWalletId(db, id));
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(11);
    expect(entries).toHaveLength(11); // abertura + 10 apostas
    expect(ledgerBalance('BRL', entries).equals(wallet.balance)).toBe(true);

    // cadeia íntegra, na ordem de inserção
    expect(entries[0]?.direction).toBe(LedgerDirection.Credit);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index] as WalletLedgerEntry;
      expect(entry.isBalanced()).toBe(true);
      if (index > 0) {
        expect(
          entry.balanceBefore.equals(
            (entries[index - 1] as WalletLedgerEntry).balanceAfter,
          ),
        ).toBe(true);
      }
    }
  });

  it('a mesma aposta enviada 10 vezes em paralelo é aplicada uma única vez', async () => {
    const id = await openWallet('100.00');
    const externalId = `bet-${randomUUID()}`;
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => placeBet(id, '10.00', externalId)),
    );

    expect(outcomes.filter((outcome) => outcome === 'PROCESSED')).toHaveLength(
      1,
    );
    expect(outcomes.filter((outcome) => outcome === 'DUPLICATE')).toHaveLength(
      9,
    );
    expect((await readWallet(id)).balance.toString()).toBe('90.00');
  });
});

describe('SqlWagerTransactionRepository', () => {
  async function insertBet(
    id: string,
    overrides: { providerId?: string; externalId?: string; key?: string } = {},
  ) {
    const bet = WagerTransaction.create({
      id: randomUUID(),
      providerId: overrides.providerId ?? 'provider-a',
      externalTransactionId: overrides.externalId ?? `ext-${randomUUID()}`,
      idempotencyKey: overrides.key ?? `key-${randomUUID()}`,
      walletId: id,
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: brl('5.00'),
    });
    const inserted = await runner.run((db) =>
      transactions.insertIfAbsent(db, bet),
    );
    return { bet, inserted };
  }

  it('insertIfAbsent recusa duplicata por external id ou por idempotency key', async () => {
    const id = await openWallet('100.00');
    const first = await insertBet(id, { externalId: 'ext-dup', key: 'key-1' });
    expect(first.inserted).toBe(true);

    expect(
      (await insertBet(id, { externalId: 'ext-dup', key: 'key-2' })).inserted,
    ).toBe(false);
    expect(
      (await insertBet(id, { externalId: 'ext-other', key: 'key-1' })).inserted,
    ).toBe(false);
    // outro provider reutiliza os mesmos identificadores sem colidir
    expect(
      (
        await insertBet(id, {
          providerId: 'provider-b',
          externalId: 'ext-dup',
          key: 'key-1',
        })
      ).inserted,
    ).toBe(true);
  });

  it('busca por id, external id e idempotency key devolve o mesmo estado', async () => {
    const id = await openWallet('100.00');
    const { bet } = await insertBet(id, {
      externalId: 'ext-find',
      key: 'key-find',
    });

    const [byId, byExternal, byKey, missing] = await runner.read(async (db) => [
      await transactions.findById(db, bet.id),
      await transactions.findByExternalId(db, 'provider-a', 'ext-find'),
      await transactions.findByIdempotencyKey(db, 'provider-a', 'key-find'),
      await transactions.findByExternalId(db, 'provider-a', 'nope'),
    ]);
    for (const found of [byId, byExternal, byKey]) {
      expect(found?.id).toBe(bet.id);
      expect(found?.money.toString()).toBe('5.00');
      expect(found?.status).toBe(WagerTransactionStatus.Pending);
      expect(found?.matchesPayload(bet.payloadHash)).toBe(true);
    }
    expect(missing).toBeUndefined();
  });

  it('saveTransition persiste a rejeição com o failureCode', async () => {
    const id = await openWallet('100.00');
    const { bet } = await insertBet(id);
    bet.reject(FailureCode.InsufficientFunds);
    await runner.run((db) => transactions.saveTransition(db, bet));

    const stored = await runner.read((db) => transactions.findById(db, bet.id));
    expect(stored?.status).toBe(WagerTransactionStatus.Rejected);
    expect(stored?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(stored?.isTerminal()).toBe(true);
  });
});
