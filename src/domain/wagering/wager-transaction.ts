import { LedgerDirection } from '../ledger/ledger-direction';
import { Money, MoneyProps } from '../money/money';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../shared/domain-error';
import { FailureCode, isInfrastructureFailure } from './failure-code';
import { computePayloadHash } from './payload-hash';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';

export { WagerTransactionKind } from './wager-transaction-kind';
export { WagerTransactionStatus } from './wager-transaction-status';

const MAX_ID_LENGTH = 255;

/**
 * Transições válidas. PROCESSED, REJECTED e FAILED são terminais.
 * PENDING_REFERENCE -> PENDING_REFERENCE é permitido: o worker reprocessa a
 * transação e, se a referência ainda não chegou, ela continua aguardando.
 */
const VALID_TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  [Status.Pending]: [
    Status.PendingReference,
    Status.Processed,
    Status.Rejected,
    Status.Failed,
  ],
  [Status.PendingReference]: [
    Status.PendingReference,
    Status.Processed,
    Status.Rejected,
    Status.Failed,
  ],
  [Status.Processed]: [],
  [Status.Rejected]: [],
  [Status.Failed]: [],
};

export function isValidTransition(from: Status, to: Status): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/** Identidade fixa da transação interna de abertura da wallet. */
const OPENING_PROVIDER_ID = 'system';
const OPENING_ROUND_ID = 'opening';
const OPENING_GAME_ID = 'opening';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  /** `OPENING` é interno e não pode ser submetido por aqui. */
  kind: Kind;
  money: Money;
  /** id da referência no provedor (não o id interno). */
  referenceExternalTransactionId?: string;
  now?: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  now?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: Status;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: Kind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: Status,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /**
   * Nasce em PENDING. Valida a exigência de referência por kind e calcula o
   * `payloadHash` a partir dos campos de negócio (o header de idempotência
   * não entra no hash).
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new InvalidTransactionError(
        'OPENING is internal and cannot be submitted',
      );
    }
    return WagerTransaction.build(props);
  }

  /** Fábrica interna para o crédito de abertura da wallet (`POST /wallets`). */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    const key = `opening:${props.walletId}`;
    return WagerTransaction.build({
      id: props.id,
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: OPENING_ROUND_ID,
      gameId: OPENING_GAME_ID,
      kind: Kind.Opening,
      money: props.money,
      now: props.now,
    });
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertValid(props);
    const payloadHash = computePayloadHash({
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money.toJSON(),
      referenceExternalTransactionId: props.referenceExternalTransactionId,
    });
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.now ?? new Date(),
      Status.Pending,
    );
  }

  private static assertValid(props: CreateWagerTransactionProps): void {
    const required: Record<string, string> = {
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
    };
    for (const [field, value] of Object.entries(required)) {
      if (
        typeof value !== 'string' ||
        value.trim() === '' ||
        value.length > MAX_ID_LENGTH
      ) {
        throw new InvalidTransactionError(
          `${field} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`,
        );
      }
    }

    if (props.money.isNegative()) {
      throw new InvalidTransactionError('money cannot be negative');
    }
    // LOSS registra o resultado sem mover saldo, então aceita valor zero.
    if (props.kind !== Kind.Loss && !props.money.isPositive()) {
      throw new InvalidTransactionError(
        `${props.kind} requires an amount greater than zero`,
      );
    }

    const reference = props.referenceExternalTransactionId;
    switch (props.kind) {
      case Kind.Refund:
      case Kind.Rollback:
        if (reference === undefined || reference.trim() === '') {
          throw new InvalidTransactionError(
            `${props.kind} requires referenceExternalTransactionId`,
          );
        }
        break;
      case Kind.Bet:
      case Kind.Opening:
        if (reference !== undefined) {
          throw new InvalidTransactionError(
            `${props.kind} cannot have a reference`,
          );
        }
        break;
      default: // WIN e LOSS: referência opcional
        if (reference !== undefined && reference.trim() === '') {
          throw new InvalidTransactionError(
            'referenceExternalTransactionId cannot be blank',
          );
        }
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidTransactionError(
        'a transaction cannot reference itself',
      );
    }
  }

  get status(): Status {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transições (lançam InvalidTransactionStateError se não forem válidas)

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidTransactionError(
        `${this.kind} requires a resolved reference`,
      );
    }
    if (
      referenceTransactionId !== undefined &&
      (this.kind === Kind.Bet || this.kind === Kind.Opening)
    ) {
      throw new InvalidTransactionError(`${this.kind} cannot have a reference`);
    }
    this.assertTransition(Status.Processed);
    this._status = Status.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    if (
      !this.requiresReference() &&
      this.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidTransactionError(
        `${this.kind} has no reference to wait for`,
      );
    }
    this.assertTransition(Status.PendingReference);
    this._status = Status.PendingReference;
  }

  /** Violação de regra de negócio. Terminal. */
  reject(code: FailureCode): void {
    if (isInfrastructureFailure(code)) {
      throw new InvalidTransactionError(
        `${code} is an infrastructure failure; use fail()`,
      );
    }
    this.assertTransition(Status.Rejected);
    this._status = Status.Rejected;
    this._failureCode = code;
  }

  /** Erro permanente de infraestrutura. Terminal e auditável. */
  fail(code: FailureCode): void {
    if (!isInfrastructureFailure(code)) {
      throw new InvalidTransactionError(
        `${code} is a business failure; use reject()`,
      );
    }
    this.assertTransition(Status.Failed);
    this._status = Status.Failed;
    this._failureCode = code;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return (
      this._status === Status.Processed ||
      this._status === Status.Rejected ||
      this._status === Status.Failed
    );
  }

  /** false para LOSS. */
  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento no ledger. Para ROLLBACK é o inverso da
   * direção da referência (que deve ser BET, WIN ou REFUND).
   * LOSS não gera lançamento.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Win:
      case Kind.Refund:
      case Kind.Opening:
        return LedgerDirection.Credit;
      case Kind.Loss:
        throw new InvalidTransactionError(
          'LOSS does not produce ledger entries',
        );
      case Kind.Rollback: {
        if (reference === undefined) {
          throw new InvalidTransactionError(
            'ROLLBACK requires the referenced transaction',
          );
        }
        if (
          reference.kind !== Kind.Bet &&
          reference.kind !== Kind.Win &&
          reference.kind !== Kind.Refund
        ) {
          throw new InvalidTransactionError(
            `ROLLBACK cannot reverse a ${reference.kind}`,
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  /**
   * Valida se `reference` é uma referência aceitável para esta transação
   * (regras 2, 3 e 5 da seção 7). Devolve o `FailureCode` da violação ou
   * `undefined` se estiver tudo certo.
   *
   * Não verifica o status da referência (PROCESSED) nem se ela já foi
   * revertida: isso depende de estado persistido e é decidido no caso de uso,
   * com o índice único parcial do banco como garantia final.
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    if (this.referenceExternalTransactionId === undefined) {
      return undefined;
    }

    if (
      reference.id === this.id ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      return FailureCode.ReferenceMismatch;
    }

    if (!this.accepts(reference.kind)) {
      return FailureCode.InvalidReferenceKind;
    }

    if (this.requiresReference() && !this.money.equals(reference.money)) {
      return FailureCode.AmountMismatch;
    }

    return undefined;
  }

  private accepts(referenceKind: Kind): boolean {
    switch (this.kind) {
      case Kind.Refund:
      case Kind.Win:
      case Kind.Loss:
        return referenceKind === Kind.Bet;
      case Kind.Rollback:
        return (
          referenceKind === Kind.Bet ||
          referenceKind === Kind.Win ||
          referenceKind === Kind.Refund
        );
      default:
        return false;
    }
  }

  private assertTransition(to: Status): void {
    if (!isValidTransition(this._status, to)) {
      throw new InvalidTransactionStateError(this._status, to);
    }
  }
}
