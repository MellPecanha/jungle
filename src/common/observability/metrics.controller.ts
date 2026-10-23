import { queueUrls } from '../../config/queues.js';
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EntityManager } from '@mikro-orm/postgresql';
import { SqsClient } from '../../infrastructure/messaging/sqs.client.js';
import { MetricsService } from './metrics.service.js';

@ApiTags('Observability')
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(EntityManager) private readonly em: EntityManager, private readonly metrics: MetricsService, private readonly sqs: SqsClient) {}

  @Get()
  @ApiOperation({ summary: 'Expõe métricas locais e agregadas' })
  async getMetrics() {
    const statuses = await this.em.fork().execute<{ status: string; count: string }[]>(`select status, count(*) as count from wager_transactions group by status`);
    const lag = await this.em.fork().execute<{ seconds: string }[]>(`select coalesce(extract(epoch from now() - min(occurred_at)), 0) as seconds from outbox_messages where published_at is null`);
    const dlqDepth = await this.sqs.queueDepth(queueUrls().deadLetters).catch(() => null);
    return {
      dlqDepth,
      transactionsByStatus: Object.fromEntries(statuses.map((row) => [row.status, Number(row.count)])),
      outboxLagSeconds: Number(lag[0]?.seconds ?? 0),
      process: this.metrics.snapshot(),
    };
  }
}
