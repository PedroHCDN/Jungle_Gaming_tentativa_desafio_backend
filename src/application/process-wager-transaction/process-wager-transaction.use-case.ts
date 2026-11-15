import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Money, type MoneyProps } from '../../domain/money/money';
import { InsufficientFundsError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  PlayerWalletMismatchError,
  WalletNotFoundError,
} from '../errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../events/wager-events';
import type {
  DbSession,
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionRunner,
  WagerTransactionRepository,
  WalletRepository,
} from '../ports/persistence';
import type { Clock, IdGenerator } from '../ports/runtime';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  nextAttemptAt,
  type PendingReferencePolicy,
} from './pending-reference-policy';

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * Mensagem de entrada (SQS) que originou o comando. Ausente na entrada HTTP.
 * Não faz parte do `payloadHash` (é metadado de transporte).
 */
export interface MessageSource {
  consumerName: string;
  messageId: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  /** Saldo ATUAL da wallet (lido com a wallet travada). */
  walletBalance: MoneyProps;
  /** `true` quando a transação já existia e nada foi reaplicado. */
  idempotentReplay: boolean;
}

export interface ProcessWagerTransactionDeps {
  runner: TransactionRunner;
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
  clock: Clock;
  ids: IdGenerator;
  /** Espera por referências fora de ordem. Padrão: 5 tentativas, backoff de 1 s. */
  pendingReference?: PendingReferencePolicy;
}

/** Reversão que deixaria o saldo negativo é uma situação distinta de aposta sem saldo. */
function insufficientFundsCode(kind: WagerTransactionKind): FailureCode {
  return kind === WagerTransactionKind.Refund ||
    kind === WagerTransactionKind.Rollback
    ? FailureCode.ReversalWouldOverdraw
    : FailureCode.InsufficientFunds;
}

/** O que a busca da referência encontrou. */
type ReferenceLookup =
  | { found: 'none' } // a transação não referencia nada
  | { found: 'missing' } // referencia algo que ainda não existe
  | { found: 'reference'; reference: WagerTransaction };

/**
 * Caso de uso único para HTTP e SQS: BET, WIN, LOSS, REFUND e ROLLBACK.
 *
 * Tudo acontece em UMA transação SQL, nesta ordem:
 *   1. trava a wallet (`FOR NO KEY UPDATE`) — lock-first, antes de qualquer leitura de saldo;
 *   2. se veio de uma mensagem SQS, registra na inbox (mesma transação): mensagem repetida
 *      devolve o resultado original; mesmo messageId com payload diferente é erro;
 *      depois registra a transação (`ON CONFLICT DO NOTHING`): se já existia, é replay ou conflito;
 *   3. `evaluate`: resolve e valida a referência e aplica a regra do kind
 *      (BET debita; WIN e REFUND creditam; ROLLBACK inverte a referência; LOSS só registra),
 *      gravando ledger + saldo + status;
 *   4. grava os eventos na outbox.
 * Se qualquer passo falha, nada é persistido. A publicação da outbox é
 * posterior ao commit.
 *
 * Referência que ainda não chegou (mensagens fora de ordem): a transação
 * fica PENDING_REFERENCE com `nextAttemptAt` e é reprocessada por
 * `retryPendingReference` (o worker da Fase 5 só precisa chamá-lo), com o
 * backoff de `PendingReferencePolicy`. Esgotadas as tentativas, vira
 * REJECTED/REFERENCE_NOT_FOUND. A chegada nova e o reprocessamento passam
 * pelo MESMO `evaluate`, então as regras não divergem.
 *
 * Por que travar a wallet ANTES de registrar a transação: uma wallet
 * inexistente é detectada sem violar a FK, e a ordem fica sempre "wallet
 * primeiro", a mesma em todos os caminhos (sem deadlock entre eles). Também
 * é isso que serializa duas reversões concorrentes da mesma referência: a
 * segunda enxerga a primeira já commitada e é rejeitada (ALREADY_REVERSED).
 */
export class ProcessWagerTransactionUseCase {
  private readonly policy: PendingReferencePolicy;

  constructor(private readonly deps: ProcessWagerTransactionDeps) {
    this.policy = deps.pendingReference ?? DEFAULT_PENDING_REFERENCE_POLICY;
  }

  async execute(
    command: ProcessWagerTransactionCommand,
    source?: MessageSource,
  ): Promise<ProcessWagerTransactionResult> {
    const now = this.deps.clock.now();
    const money = Money.from(command.money); // rejeita number, vírgula, >2 casas…
    const transaction = WagerTransaction.create({
      id: this.deps.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      now,
    });

    return this.deps.runner.run((db) =>
      this.processNew(db, transaction, now, source),
    );
  }

  /**
   * Reprocessa uma transação PENDING_REFERENCE (chamado pelo worker).
   * Devolve `undefined` quando não há nada a fazer: a transação não existe,
   * já saiu de PENDING_REFERENCE (outro worker a resolveu) ou ainda não está
   * na hora (`nextAttemptAt` no futuro), para não gastar tentativas à toa.
   */
  async retryPendingReference(
    transactionId: string,
  ): Promise<ProcessWagerTransactionResult | undefined> {
    const now = this.deps.clock.now();
    return this.deps.runner.run(async (db) => {
      const peek = await this.deps.transactions.findById(db, transactionId);
      if (peek?.status !== WagerTransactionStatus.PendingReference)
        return undefined;

      const wallet = await this.deps.wallets.findByIdForUpdate(
        db,
        peek.walletId,
      );
      if (wallet === undefined) throw new WalletNotFoundError(peek.walletId);

      // Relê com a wallet travada: outro worker pode ter resolvido nesse meio-tempo.
      const transaction = await this.deps.transactions.findById(
        db,
        transactionId,
      );
      if (transaction?.status !== WagerTransactionStatus.PendingReference)
        return undefined;
      if (
        transaction.nextAttemptAt !== undefined &&
        transaction.nextAttemptAt > now
      ) {
        return undefined;
      }

      return this.evaluate(db, transaction, wallet, now);
    });
  }

  private async processNew(
    db: DbSession,
    transaction: WagerTransaction,
    now: Date,
    source: MessageSource | undefined,
  ): Promise<ProcessWagerTransactionResult> {
    const wallet = await this.deps.wallets.findByIdForUpdate(
      db,
      transaction.walletId,
    );
    if (wallet === undefined)
      throw new WalletNotFoundError(transaction.walletId);
    if (wallet.playerId !== transaction.playerId) {
      throw new PlayerWalletMismatchError(wallet.id, transaction.playerId);
    }

    if (source !== undefined) {
      const registration = await this.deps.inbox.register(db, {
        consumerName: source.consumerName,
        messageId: source.messageId,
        payloadHash: transaction.payloadHash,
        receivedAt: now,
      });
      if (!registration.registered) {
        if (registration.payloadHash !== transaction.payloadHash) {
          throw new InboxPayloadMismatchError(
            source.consumerName,
            source.messageId,
          );
        }
        // Entrega repetida da mesma mensagem: o efeito já foi commitado junto
        // com a linha da inbox, então devolve o resultado original.
        return this.replay(db, transaction, wallet);
      }
    }

    if (!(await this.deps.transactions.insertIfAbsent(db, transaction))) {
      return this.replay(db, transaction, wallet);
    }
    return this.evaluate(db, transaction, wallet, now);
  }

  /**
   * Regras de negócio sobre uma transação já registrada, com a wallet travada.
   * Serve à chegada nova (PENDING) e ao reprocessamento (PENDING_REFERENCE).
   */
  private async evaluate(
    db: DbSession,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    const { transactions } = this.deps;

    if (transaction.money.currency !== wallet.currency) {
      return this.reject(
        db,
        transaction,
        wallet,
        FailureCode.CurrencyMismatch,
        now,
      );
    }

    const lookup = await this.lookupReference(db, transaction);
    if (lookup.found === 'missing') {
      return this.waitForReference(
        db,
        transaction,
        wallet,
        now,
        FailureCode.ReferenceNotFound,
      );
    }

    const reference =
      lookup.found === 'reference' ? lookup.reference : undefined;
    if (reference !== undefined) {
      const violation = transaction.checkReference(reference);
      if (violation !== undefined) {
        return this.reject(db, transaction, wallet, violation, now);
      }
      if (reference.status === WagerTransactionStatus.PendingReference) {
        // a referência também está esperando a dela (ex.: ROLLBACK de um REFUND pendente)
        return this.waitForReference(
          db,
          transaction,
          wallet,
          now,
          FailureCode.ReferenceNotProcessed,
        );
      }
      if (reference.status !== WagerTransactionStatus.Processed) {
        // a referência foi REJECTED/FAILED: não há o que ligar a ela nem reverter
        return this.reject(
          db,
          transaction,
          wallet,
          FailureCode.ReferenceNotProcessed,
          now,
        );
      }
      if (
        transaction.requiresReference() &&
        (await transactions.findReversalOf(db, reference.id)) !== undefined
      ) {
        return this.reject(
          db,
          transaction,
          wallet,
          FailureCode.AlreadyReversed,
          now,
        );
      }
    }

    // LOSS só registra o resultado: sem lançamento, sem mudança de saldo
    // (e portanto sem WalletBalanceChanged).
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, now);
      await transactions.saveTransition(db, transaction);
      await this.deps.outbox.append(
        db,
        new WagerTransactionProcessed(this.deps.ids.next(), now, transaction),
      );
      return this.result(transaction, wallet, false);
    }

    let movement;
    try {
      movement =
        transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(transaction.money, now)
          : wallet.credit(transaction.money, now);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return this.reject(
          db,
          transaction,
          wallet,
          insufficientFundsCode(transaction.kind),
          now,
        );
      }
      throw error;
    }

    await this.deps.ledger.append(
      db,
      WalletLedgerEntry.fromMovement(movement, {
        id: this.deps.ids.next(),
        walletId: wallet.id,
        transactionId: transaction.id,
        createdAt: now,
      }),
    );
    await this.deps.wallets.saveMovement(db, wallet);
    transaction.markProcessed(reference?.id, now);
    await transactions.saveTransition(db, transaction);

    await this.deps.outbox.append(
      db,
      new WagerTransactionProcessed(this.deps.ids.next(), now, transaction),
    );
    await this.deps.outbox.append(
      db,
      new WalletBalanceChanged(this.deps.ids.next(), now, wallet.id, {
        transactionId: transaction.id,
        direction: movement.direction,
        money: movement.money,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
        walletVersion: movement.walletVersion,
      }),
    );

    return this.result(transaction, wallet, false);
  }

  /** Busca a transação referenciada por `(providerId, referenceExternalTransactionId)`. */
  private async lookupReference(
    db: DbSession,
    transaction: WagerTransaction,
  ): Promise<ReferenceLookup> {
    const referenceExternalId = transaction.referenceExternalTransactionId;
    if (referenceExternalId === undefined) return { found: 'none' };

    const reference = await this.deps.transactions.findByExternalId(
      db,
      transaction.providerId,
      referenceExternalId,
    );
    return reference === undefined
      ? { found: 'missing' }
      : { found: 'reference', reference };
  }

  /**
   * A referência ainda não está disponível. Agenda a próxima tentativa com
   * backoff exponencial; se as tentativas acabaram, rejeita com `exhaustedCode`.
   * O evento `WagerTransactionPendingReference` sai só na primeira espera.
   */
  private async waitForReference(
    db: DbSession,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
    exhaustedCode: FailureCode,
  ): Promise<ProcessWagerTransactionResult> {
    const next = nextAttemptAt(
      this.policy,
      transaction.referenceAttempts + 1,
      now,
    );
    if (next === undefined) {
      return this.reject(db, transaction, wallet, exhaustedCode, now);
    }

    const firstWait = transaction.status === WagerTransactionStatus.Pending;
    transaction.markPendingReference(next);
    await this.deps.transactions.saveTransition(db, transaction);
    if (firstWait) {
      await this.deps.outbox.append(
        db,
        new WagerTransactionPendingReference(
          this.deps.ids.next(),
          now,
          transaction,
        ),
      );
    }
    return this.result(transaction, wallet, false);
  }

  private async reject(
    db: DbSession,
    transaction: WagerTransaction,
    wallet: Wallet,
    code: FailureCode,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    transaction.reject(code);
    await this.deps.transactions.saveTransition(db, transaction);
    await this.deps.outbox.append(
      db,
      new WagerTransactionRejected(this.deps.ids.next(), now, transaction),
    );
    return this.result(transaction, wallet, false);
  }

  /**
   * `insertIfAbsent` devolveu false: já existe uma transação com a mesma
   * idempotency key ou o mesmo external id. Mesmo payload => devolve o
   * resultado original sem reaplicar nada; payload diferente => conflito.
   */
  private async replay(
    db: DbSession,
    incoming: WagerTransaction,
    wallet: Wallet,
  ): Promise<ProcessWagerTransactionResult> {
    const { transactions } = this.deps;
    const existing =
      (await transactions.findByIdempotencyKey(
        db,
        incoming.providerId,
        incoming.idempotencyKey,
      )) ??
      (await transactions.findByExternalId(
        db,
        incoming.providerId,
        incoming.externalTransactionId,
      ));

    if (existing === undefined) {
      throw new Error(
        `transaction ${incoming.externalTransactionId} conflicted on insert but was not found`,
      );
    }
    if (!existing.matchesPayload(incoming.payloadHash)) {
      throw new IdempotencyConflictError(
        incoming.providerId,
        incoming.idempotencyKey,
        incoming.externalTransactionId,
      );
    }
    return this.result(existing, wallet, true);
  }

  private result(
    transaction: WagerTransaction,
    wallet: Wallet,
    idempotentReplay: boolean,
  ): ProcessWagerTransactionResult {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      ...(transaction.failureCode !== undefined && {
        failureCode: transaction.failureCode,
      }),
      walletBalance: wallet.balance.toJSON(),
      idempotentReplay,
    };
  }
}
