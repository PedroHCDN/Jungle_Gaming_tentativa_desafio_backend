import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20261114120000 } from './migrations/Migration20261114120000';

export const DEFAULT_DATABASE_URL =
  'postgres://wagering:wagering@localhost:5432/wagering';

/**
 * Configuração do MikroORM 7.
 *
 * - As migrations são registradas por classe (`migrationsList`), sem
 *   descoberta de arquivos: funciona igual em Bun, em dev e no Docker.
 * - `snapshot: false`: o schema é escrito à mão em SQL (com constraints e
 *   triggers que o diff do MikroORM não conhece), então não há snapshot.
 * - Novas migrations entram na lista abaixo, em ordem.
 */
export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    tableName: 'mikro_orm_migrations',
    transactional: true,
    allOrNothing: true,
    snapshot: false,
    migrationsList: [
      { name: 'Migration20261114120000', class: Migration20261114120000 },
    ],
  },
});
