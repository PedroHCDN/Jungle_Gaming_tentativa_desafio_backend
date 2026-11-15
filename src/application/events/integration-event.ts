import type { MoneyProps } from '../../domain/money/money';

/**
 * Evento de integração gravado na outbox, na mesma transação do efeito
 * financeiro. O `aggregateId` é a wallet: a ordem por wallet é a que importa.
 *
 * Valores monetários viajam como `MoneyProps` (string decimal), nunca como
 * instância de Money nem como number.
 */
export abstract class IntegrationEvent {
  abstract readonly eventType: string;
  readonly version = 1;

  protected constructor(
    public readonly eventId: string,
    public readonly aggregateId: string,
    public readonly occurredAt: Date,
  ) {}

  /** Dados específicos do evento (JSON-safe). */
  abstract data(): Record<string, unknown>;

  /** Envelope completo: é o que a outbox grava e o publisher encaminha. */
  toPayload(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      version: this.version,
      aggregateId: this.aggregateId,
      occurredAt: this.occurredAt.toISOString(),
      data: this.data(),
    };
  }
}

export type { MoneyProps };
