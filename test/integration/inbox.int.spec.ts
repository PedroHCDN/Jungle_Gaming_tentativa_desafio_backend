import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  InboxPayloadMismatchError,
  WalletNotFoundError,
} from '../../src/application/errors';
import type { OutboxRepository } from '../../src/application/ports/persistence';
import {
  type MessageSource,
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../src/application/process-wager-transaction/process-wager-transaction.use-case';
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
 * Inbox (entrada SQS): a deduplicação por mensagem vive na MESMA transação do
 * efeito financeiro, então não existe "processou mas não registrou" nem o inverso.
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

interface Owner {
  walletId: string;
  playerId: string;
}

function bet(owner: Owner, amount: string): ProcessWagerTransactionCommand {
  const id = randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId: `bet-${id}`,
    idempotencyKey: `key-${id}`,
    walletId: owner.walletId,
    playerId: owner.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: 'BRL' },
  };
}

const message = (consumerName = 'wager-consumer'): MessageSource => ({
  consumerName,
  messageId: `msg-${randomUUID()}`,
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

interface InboxRow {
  consumer_name: string;
  message_id: string;
  payload_hash: string;
  received_at: Date;
  processed_at: Date | null;
}

async function inboxRows(messageId: string): Promise<InboxRow[]> {
  const rows: unknown = await database.sql.unsafe(
    `SELECT consumer_name, message_id, payload_hash, received_at, processed_at
       FROM inbox_messages WHERE message_id = $1 ORDER BY consumer_name`,
    [messageId],
  );
  return rows as InboxRow[];
}

async function outboxCount(walletId: string): Promise<number> {
  const rows: unknown = await database.sql.unsafe(
    `SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = $1`,
    [walletId],
  );
  return (rows as { n: number }[])[0]?.n ?? 0;
}

const balanceOf = async (owner: Owner) =>
  (
    await runner.read((db) => wallets.findById(db, owner.walletId))
  )?.balance.toString();

describe('inbox: registro junto com o efeito', () => {
  it('a mensagem fica registrada com o hash do payload e a hora do processamento', async () => {
    const owner = await openWallet(runner, '100.00');
    const command = bet(owner, '30.00');
    const source = message();
    const result = await useCase.execute(command, source);

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    const rows = await inboxRows(source.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumer_name).toBe(source.consumerName);
    expect(rows[0]?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.processed_at).toBeInstanceOf(Date);

    const stored = await runner.read((db) =>
      transactions.findByExternalId(
        db,
        command.providerId,
        command.externalTransactionId,
      ),
    );
    expect(rows[0]?.payload_hash).toBe(stored?.payloadHash as string); // mesmo hash de negócio
  });

  it('sem origem de mensagem (HTTP) nada é gravado na inbox', async () => {
    const owner = await openWallet(runner, '100.00');
    const before = await database.sql.unsafe(
      `SELECT count(*)::int AS n FROM inbox_messages`,
    );
    await useCase.execute(bet(owner, '10.00'));
    const after = await database.sql.unsafe(
      `SELECT count(*)::int AS n FROM inbox_messages`,
    );
    expect((after as { n: number }[])[0]?.n).toBe(
      (before as { n: number }[])[0]?.n,
    );
  });

  it('o resultado REJECTED também consome a mensagem (a reentrega devolve a rejeição)', async () => {
    const owner = await openWallet(runner, '10.00');
    const command = bet(owner, '50.00');
    const source = message();

    const first = await useCase.execute(command, source);
    const second = await useCase.execute(command, source);

    expect(first.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(second).toMatchObject({
      idempotentReplay: true,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(await inboxRows(source.messageId)).toHaveLength(1);
  });
});

describe('inbox: entrega repetida (SQS é at-least-once)', () => {
  it('a mesma mensagem entregue duas vezes aplica o efeito uma vez só', async () => {
    const owner = await openWallet(runner, '100.00');
    const command = bet(owner, '30.00');
    const source = message();

    const first = await useCase.execute(command, source);
    const second = await useCase.execute(command, source);

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await balanceOf(owner)).toBe('70.00');
    expect(await inboxRows(source.messageId)).toHaveLength(1);
    expect(await outboxCount(owner.walletId)).toBe(2); // sem eventos duplicados
  });

  it('20 entregas simultâneas da mesma mensagem: um efeito e uma linha na inbox', async () => {
    const owner = await openWallet(runner, '100.00');
    const command = bet(owner, '10.00');
    const source = message();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => useCase.execute(command, source)),
    );

    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(
      1,
    );
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(await balanceOf(owner)).toBe('90.00');
    expect(await inboxRows(source.messageId)).toHaveLength(1);
  });

  it('mensagens diferentes com o mesmo fato de negócio: replay, e as duas ficam registradas', async () => {
    const owner = await openWallet(runner, '100.00');
    const command = bet(owner, '30.00');
    const first = message();
    const second = message(); // o provedor reenviou por outra mensagem

    await useCase.execute(command, first);
    const replay = await useCase.execute(command, second);

    expect(replay.idempotentReplay).toBe(true);
    expect(await balanceOf(owner)).toBe('70.00');
    expect(await inboxRows(first.messageId)).toHaveLength(1);
    expect(await inboxRows(second.messageId)).toHaveLength(1);
  });

  it('o mesmo messageId em consumers diferentes são mensagens independentes', async () => {
    const owner = await openWallet(runner, '100.00');
    const messageId = `msg-${randomUUID()}`;
    const a = await useCase.execute(bet(owner, '10.00'), {
      consumerName: 'consumer-a',
      messageId,
    });
    const b = await useCase.execute(bet(owner, '10.00'), {
      consumerName: 'consumer-b',
      messageId,
    });

    expect(a.idempotentReplay).toBe(false);
    expect(b.idempotentReplay).toBe(false);
    expect(await balanceOf(owner)).toBe('80.00');
    expect(
      (await inboxRows(messageId)).map((row) => row.consumer_name),
    ).toEqual(['consumer-a', 'consumer-b']);
  });

  it('o mesmo messageId com payload diferente: InboxPayloadMismatchError e nada muda', async () => {
    const owner = await openWallet(runner, '100.00');
    const source = message();
    await useCase.execute(bet(owner, '30.00'), source);

    const error = await rejection(useCase.execute(bet(owner, '5.00'), source));
    expect(error).toBeInstanceOf(InboxPayloadMismatchError);
    expect(await balanceOf(owner)).toBe('70.00');
    expect(await inboxRows(source.messageId)).toHaveLength(1);
  });
});

describe('inbox: atomicidade com o efeito', () => {
  it('se a outbox falha, a inbox também é desfeita e a reentrega funciona', async () => {
    const owner = await openWallet(runner, '100.00');
    const command = bet(owner, '30.00');
    const source = message();
    const failing = buildUseCase({
      append: () => Promise.reject(new Error('outbox indisponível')),
    });

    expect(await rejection(failing.execute(command, source))).toMatchObject({
      message: 'outbox indisponível',
    });
    expect(await inboxRows(source.messageId)).toHaveLength(0); // não ficou "recebida"
    expect(await balanceOf(owner)).toBe('100.00');

    const redelivered = await useCase.execute(command, source);
    expect(redelivered.status).toBe(WagerTransactionStatus.Processed);
    expect(redelivered.idempotentReplay).toBe(false);
    expect(await balanceOf(owner)).toBe('70.00');
  });

  it('erro de negócio que aborta (wallet inexistente) não deixa a mensagem registrada', async () => {
    const source = message();
    const command = bet(
      { walletId: randomUUID(), playerId: 'player-x' },
      '10.00',
    );

    expect(await rejection(useCase.execute(command, source))).toBeInstanceOf(
      WalletNotFoundError,
    );
    expect(await inboxRows(source.messageId)).toHaveLength(0);
  });
});
