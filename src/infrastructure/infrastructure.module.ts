import { Global, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './database/mikro-orm.config.js';
import { SqsClient } from './messaging/sqs.client.js';

@Global()
@Module({ imports: [MikroOrmModule.forRoot(mikroOrmConfig)], providers: [SqsClient], exports: [SqsClient] })
export class InfrastructureModule {}
