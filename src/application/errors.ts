/** Erros da camada de aplicação: o que a API/consumer traduz para o provedor. */
export abstract class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Mesma identidade de transação (idempotency key ou external id) chegou com
 * payload diferente. Nada é alterado. HTTP: 409.
 */
export class IdempotencyConflictError extends ApplicationError {
  constructor(
    public readonly providerId: string,
    public readonly idempotencyKey: string,
    public readonly externalTransactionId: string,
  ) {
    super(
      `provider ${providerId}: idempotency key "${idempotencyKey}" / external transaction "${externalTransactionId}" was already used with a different payload`,
    );
  }
}

/** A wallet informada não existe. Nada é persistido. HTTP: 404. */
export class WalletNotFoundError extends ApplicationError {
  constructor(public readonly walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

/** O `playerId` da transação não é o dono da wallet. Nada é persistido. */
export class PlayerWalletMismatchError extends ApplicationError {
  constructor(
    public readonly walletId: string,
    public readonly playerId: string,
  ) {
    super(`wallet ${walletId} does not belong to player ${playerId}`);
  }
}

/**
 * O mesmo `(consumerName, messageId)` chegou com payload diferente do já
 * registrado. Uma mensagem não muda de conteúdo: é um defeito do produtor
 * (não adianta reprocessar; o consumer deve descartar para a DLQ).
 */
export class InboxPayloadMismatchError extends ApplicationError {
  constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
  ) {
    super(
      `consumer ${consumerName}: message ${messageId} was already received with a different payload`,
    );
  }
}
