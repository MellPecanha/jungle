
import 'dotenv/config';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

export default defineConfig({
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  dbName: process.env.DATABASE_NAME ?? 'jungle_wagering',
  user: process.env.DATABASE_USER ?? 'jungle',
  password: process.env.DATABASE_PASSWORD ?? 'jungle_dev',

  entities: [],
  extensions: [Migrator],
  discovery: {
    warnWhenNoEntities: false,
  },

  migrations: {
    path: 'dist/infrastructure/database/migrations',
    pathTs: 'src/infrastructure/database/migrations',
    glob: '!(*.d).{js,ts}',
  },

  allowGlobalContext: false,
});
