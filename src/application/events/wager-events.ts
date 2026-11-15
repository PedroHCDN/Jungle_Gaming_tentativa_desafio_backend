import type { LedgerDirection } from '../../domain/ledger/ledger-direction';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { IntegrationEvent } from './integration-event';

function transactionData(
  transaction: WagerTransaction,
): Record<string, unknown> {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}

/** A transação foi aplicada (inclusive LOSS, que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent {
  readonly eventType = 'WagerTransactionProcessed';

  constructor(
    eventId: string,
    occurredAt: Date,
    private readonly transaction: WagerTransaction,
  ) {
    super(eventId, transaction.walletId, occurredAt);
  }

  data(): Record<string, unknown> {
    return {
      ...transactionData(this.transaction),
      processedAt: this.transaction.processedAt?.toISOString() ?? null,
    };
  }
}

/** A referência ainda não chegou: a transação aguarda e será reprocessada. */
export class WagerTransactionPendingReference extends IntegrationEvent {
  readonly eventType = 'WagerTransactionPendingReference';

  constructor(
    eventId: string,
    occurredAt: Date,
    private readonly transaction: WagerTransaction,
  ) {
    super(eventId, transaction.walletId, occurredAt);
  }

  data(): Record<string, unknown> {
    return {
      ...transactionData(this.transaction),
      referenceExternalTransactionId:
        this.transaction.referenceExternalTransactionId ?? null,
      nextAttemptAt: this.transaction.nextAttemptAt?.toISOString() ?? null,
    };
  }
}

/** A transação foi rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent {
  readonly eventType = 'WagerTransactionRejected';

  constructor(
    eventId: string,
    occurredAt: Date,
    private readonly transaction: WagerTransaction,
  ) {
    super(eventId, transaction.walletId, occurredAt);
  }

  data(): Record<string, unknown> {
    return {
      ...transactionData(this.transaction),
      failureCode: this.transaction.failureCode ?? null,
    };
  }
}

/** O saldo da wallet mudou (só quando muda: nunca para LOSS ou rejeição). */
export class WalletBalanceChanged extends IntegrationEvent {
  readonly eventType = 'WalletBalanceChanged';

  constructor(
    eventId: string,
    occurredAt: Date,
    walletId: string,
    private readonly change: {
      transactionId: string;
      direction: LedgerDirection;
      money: Money;
      balanceBefore: Money;
      balanceAfter: Money;
      walletVersion: number;
    },
  ) {
    super(eventId, walletId, occurredAt);
  }

  data(): Record<string, unknown> {
    return {
      walletId: this.aggregateId,
      transactionId: this.change.transactionId,
      direction: this.change.direction,
      money: this.change.money.toJSON(),
      balanceBefore: this.change.balanceBefore.toJSON(),
      balanceAfter: this.change.balanceAfter.toJSON(),
      walletVersion: this.change.walletVersion,
    };
  }
}
