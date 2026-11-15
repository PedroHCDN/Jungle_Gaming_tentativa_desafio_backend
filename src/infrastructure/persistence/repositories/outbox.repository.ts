import type {
  DbSession,
  OutboxRepository,
} from '../../../application/ports/persistence';
import type { IntegrationEvent } from '../../../application/events/integration-event';

export class SqlOutboxRepository implements OutboxRepository {
  async append(db: DbSession, event: IntegrationEvent): Promise<void> {
    // O payload vai como texto e é convertido no banco: passar o objeto
    // direto faria alguns drivers gravarem uma *string* JSON, não um objeto.
    await db.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       VALUES (?, ?, ?, ?::text::jsonb, ?)`,
      [
        event.eventId,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.toPayload()),
        event.occurredAt,
      ],
    );
  }
}
