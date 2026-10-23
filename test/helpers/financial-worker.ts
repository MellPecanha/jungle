import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/database/mikro-orm.config.js';
import { ProcessWagerTransactionService, type ProcessWagerInput } from '../../src/modules/wagering/process-wager-transaction.service.js';

const schema = process.env.TEST_SCHEMA;
if (!schema || !/^test_[a-f0-9]+$/.test(schema) || !process.argv[2]) throw new Error('Test schema and input required');
const orm = await MikroORM.init({ ...config, schema, driverOptions: { options: `-c search_path=${schema}` } });
try {
  const result = await new ProcessWagerTransactionService(orm.em.fork()).execute(JSON.parse(process.argv[2]) as ProcessWagerInput);
  process.stdout.write(JSON.stringify(result));
} finally {
  await orm.close();
}
