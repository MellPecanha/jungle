import { queueUrls } from '../../config/queues.js';
import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject } from '@nestjs/common';
import { SqsClient } from '../../infrastructure/messaging/sqs.client.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@Inject(EntityManager) private readonly em: EntityManager, private readonly sqs: SqsClient) {}

  @Get('live')
  @ApiOperation({ summary: 'Verifica se a aplicação está ativa' })
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Verifica PostgreSQL e SQS' })
  async ready() {
    try {
      await this.em.getConnection().execute('select 1');
      await this.sqs.check(queueUrls().wagers);
      return { status: 'ok', dependencies: { postgres: 'ok', sqs: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        dependencies: { postgres: 'unknown', sqs: 'unknown' },
      });
    }
  }
}
