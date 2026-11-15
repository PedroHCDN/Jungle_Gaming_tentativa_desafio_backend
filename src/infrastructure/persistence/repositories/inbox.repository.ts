import type {
  DbSession,
  InboxMessage,
  InboxRegistration,
  InboxRepository,
} from '../../../application/ports/persistence';
import { PersistenceError, type Row, text } from '../row-parsers';

export class SqlInboxRepository implements InboxRepository {
  async register(
    db: DbSession,
    message: InboxMessage,
  ): Promise<InboxRegistration> {
    // A linha nasce junto com o efeito (mesma transação), então só é visível
    // depois do commit: `processed_at` já é o instante do processamento.
    const inserted = await db.query<Row>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.receivedAt,
      ],
    );
    if (inserted.length > 0) return { registered: true };

    const existing = await db.query<Row>(
      `SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
      [message.consumerName, message.messageId],
    );
    const row = existing[0];
    if (row === undefined) {
      throw new PersistenceError(
        `inbox message ${message.consumerName}/${message.messageId} conflicted on insert but was not found`,
      );
    }
    return { registered: false, payloadHash: text(row, 'payload_hash') };
  }
}
