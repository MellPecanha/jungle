import { queueUrls } from '../../config/queues.js';
import { MetricsService } from '../../common/observability/metrics.service.js';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject } from '@nestjs/common';
import { SqsClient } from './sqs.client.js';
import { OutboxMessage } from './outbox-message.js';

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly queueUrl = queueUrls().events;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly sqs: SqsClient,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async publishBatch(limit = 10): Promise<number> {
    let published = 0;
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    for (let index = 0; index < safeLimit; index += 1) {
      const result = await this.em.transactional(async (tx) => {
        const messages = await tx.execute<Record<string, unknown>[]>(
          `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at from outbox_messages
           where published_at is null and next_attempt_at <= now()
           order by occurred_at, id
           for update skip locked limit 1`,
        );
        const row = messages[0];
        if (!row) return false;
        const message = OutboxMessage.rehydrate({
          id: String(row.id), aggregateId: String(row.aggregate_id), eventType: String(row.event_type),
          payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
          occurredAt: new Date(row.occurred_at as string | Date), attempts: Number(row.attempts),
          nextAttemptAt: new Date(row.next_attempt_at as string | Date),
          publishedAt: row.published_at ? new Date(row.published_at as string | Date) : undefined,
        });
        try {
          await this.sqs.publish(this.queueUrl, JSON.stringify(message.payload), message.aggregateId);
          const [{ now }] = await tx.execute<{ now: Date }[]>(`select now() as now`);
          message.markPublished(new Date(now));
          await tx.execute(`update outbox_messages set published_at = ? where id = ?`, [message.publishedAt, message.id], 'run');
          return true;
        } catch (error) {
          this.logger.error(JSON.stringify({ message: 'outbox publication failed', eventId: message.id, error: error instanceof Error ? error.message : 'unknown' }));
          this.metrics?.increment('outboxRetries');
          const [{ now }] = await tx.execute<{ now: Date }[]>(`select now() as now`);
          message.scheduleRetry(new Date(now));
          await tx.execute(
            `update outbox_messages
             set attempts = ?, next_attempt_at = ?
             where id = ?`,
            [message.attempts, message.nextAttemptAt, message.id],
            'run',
          );
          return false;
        }
      });
      if (!result) break;
      published += 1;
    }
    return published;
  }
}
