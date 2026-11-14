/**
 * Erro base do domínio. `code` é estável e legível por máquina;
 * a camada de aplicação o mapeia para o failureCode / status HTTP.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class MoneyOverflowError extends DomainError {
  readonly code = 'MONEY_OVERFLOW';

  constructor() {
    super('Money amount exceeds the supported range (numeric(19,2))');
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';

  constructor(message = 'Amount must be greater than zero') {
    super(message);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly balance: string,
    readonly requested: string,
  ) {
    super(`Insufficient funds: balance ${balance}, requested ${requested}`);
  }
}

/** Dados inválidos na criação/uso de uma WagerTransaction (erro de programação ou de contrato). */
export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';

  constructor(message: string) {
    super(message);
  }
}

/** Transição de status proibida (ex.: tentar mudar uma transação terminal). Erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(from: string, to: string) {
    super(`Invalid transaction status transition: ${from} -> ${to}`);
  }
}
