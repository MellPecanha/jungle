import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/database/mikro-orm.config.js';
import { SqsClient } from '../../src/infrastructure/messaging/sqs.client.js';
import { WagerConsumerService } from '../../src/modules/wagering/wager-consumer.service.js';
import { ProcessWagerTransactionService } from '../../src/modules/wagering/process-wager-transaction.service.js';

const schema = process.env.TEST_SCHEMA;
if (!schema || !/^test_[a-f0-9]+$/.test(schema)) throw new Error('Test schema required');
class CrashBeforeAck extends SqsClient {
  override async acknowledge(queue: string, handle: string): Promise<void> {
    await this.changeVisibility(queue, handle, 0);
    process.exit(23);
  }
}
const orm = await MikroORM.init({ ...config, schema, driverOptions: { options: `-c search_path=${schema}` } });
await new WagerConsumerService(new CrashBeforeAck(), orm.em.fork(), new ProcessWagerTransactionService(orm.em.fork())).processAvailable();
await orm.close();
