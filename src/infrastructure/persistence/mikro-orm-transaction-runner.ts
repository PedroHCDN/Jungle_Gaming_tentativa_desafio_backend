import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  DbSession,
  TransactionRunner,
} from '../../application/ports/persistence';

/** Sessão sobre um `EntityManager` (o da transação ou um fork para leitura). */
class MikroOrmSession implements DbSession {
  constructor(private readonly em: EntityManager) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows: unknown = await this.em.execute(sql, [...params]);
    return rows as T[];
  }
}

/**
 * Fronteira de transação sobre o MikroORM. `em.transactional` entrega um
 * EntityManager já preso à transação; tudo que passar por ele (e só por ele)
 * roda no mesmo BEGIN/COMMIT. Exceção no callback => ROLLBACK.
 */
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(private readonly em: EntityManager) {}

  run<T>(work: (db: DbSession) => Promise<T>): Promise<T> {
    return this.em.transactional((tx) => work(new MikroOrmSession(tx)));
  }

  read<T>(work: (db: DbSession) => Promise<T>): Promise<T> {
    return work(new MikroOrmSession(this.em.fork()));
  }
}
