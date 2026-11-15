import { Migration } from '@mikro-orm/migrations';
import { DOWN_STATEMENTS, UP_STATEMENTS } from '../schema/initial-schema.sql';

/**
 * Schema inicial: wallets, wager_transactions, wallet_ledger_entries,
 * inbox_messages e outbox_messages, com as garantias no banco.
 *
 * O SQL fica em `initial-schema.sql.ts`, para os testes de integração
 * aplicarem exatamente o mesmo schema. Esta migration é reversível: o
 * `down` remove tudo na ordem inversa das dependências.
 */
export class Migration20261114120000 extends Migration {
  override up(): void {
    for (const statement of UP_STATEMENTS) {
      this.addSql(statement);
    }
  }

  override down(): void {
    for (const statement of DOWN_STATEMENTS) {
      this.addSql(statement);
    }
  }
}
