import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

/** Aplica as migrations pendentes. Uso: `bun run db:migrate`. */
const orm = await MikroORM.init(config);
try {
  const applied = await orm.migrator.up();
  console.log(
    applied.length > 0
      ? `Migrations aplicadas: ${applied.map((m) => m.name).join(', ')}`
      : 'Nenhuma migration pendente.',
  );
} finally {
  await orm.close(true);
}
