import { SQL } from 'bun';
import { randomUUID } from 'node:crypto';
import {
  DOWN_STATEMENTS,
  UP_STATEMENTS,
} from '../../../src/infrastructure/persistence/schema/initial-schema.sql';

/** Banco de administração (o do `docker compose`) usado para criar o de teste. */
export function adminDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ??
    'postgres://wagering:wagering@localhost:5432/wagering'
  );
}

export interface TestDatabase {
  readonly sql: SQL;
  readonly name: string;
  /** Aplica a migration de novo (útil para testar o `down`). */
  applySchema(): Promise<void>;
  revertSchema(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Cria um banco novo e isolado no PostgreSQL real, aplica o schema e
 * devolve o cliente. `close()` apaga o banco, então os testes não deixam
 * lixo nem interferem entre si.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = new SQL(adminDatabaseUrl());
  const name = `wagering_test_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);

  const url = new URL(adminDatabaseUrl());
  url.pathname = `/${name}`;
  const sql = new SQL(url.toString());

  const run = async (statements: readonly string[]): Promise<void> => {
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  };

  const database: TestDatabase = {
    sql,
    name,
    applySchema: () => run(UP_STATEMENTS),
    revertSchema: () => run(DOWN_STATEMENTS),
    close: async () => {
      await sql.close();
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close();
    },
  };

  await database.applySchema();
  return database;
}
