import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/infrastructure/database/mikro-orm.config.js';
import { SqsClient } from '../../src/infrastructure/messaging/sqs.client.js';
import { OutboxPublisherService } from '../../src/infrastructure/messaging/outbox-publisher.service.js';

const schema = process.env.TEST_SCHEMA;
if (!schema || !/^test_[a-f0-9]+$/.test(schema)) throw new Error('Test schema required');
class CrashAfterPublish extends SqsClient {
  override async publish(queue: string, body: string, group: string): Promise<void> {
    await super.publish(queue, body, group);
    process.exit(24);
  }
}
const orm = await MikroORM.init({ ...config, schema, driverOptions: { options: `-c search_path=${schema}` } });
await new OutboxPublisherService(orm.em.fork(), new CrashAfterPublish()).publishBatch(1);
await orm.close();
