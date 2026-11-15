import type {
  DbSession,
  TransactionRunner,
} from '../../../src/application/ports/persistence';
import type { TestDatabase } from './test-database';

type Client = Pick<TestDatabase['sql'], 'unsafe'>;

/** `?` (convenção dos repositories/MikroORM) -> `$1, $2…` (protocolo do PostgreSQL). */
export function toPositional(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

class BunSession implements DbSession {
  constructor(private readonly client: Client) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows: unknown = await this.client.unsafe(toPositional(sql), [
      ...params,
    ]);
    return rows as T[];
  }
}

/**
 * Executa os MESMOS repositories de produção contra o PostgreSQL real, usando
 * o cliente do Bun: `sql.begin` abre uma transação numa conexão do pool
 * (BEGIN/COMMIT/ROLLBACK reais, como no `em.transactional`).
 */
export class BunTransactionRunner implements TransactionRunner {
  constructor(private readonly sql: TestDatabase['sql']) {}

  run<T>(work: (db: DbSession) => Promise<T>): Promise<T> {
    return this.sql.begin((tx) => work(new BunSession(tx)));
  }

  read<T>(work: (db: DbSession) => Promise<T>): Promise<T> {
    return work(new BunSession(this.sql));
  }
}
