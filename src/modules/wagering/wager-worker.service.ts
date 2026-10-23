import { Injectable, Logger, Optional, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { MetricsService } from '../../common/observability/metrics.service.js';
import { Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxPublisherService } from '../../infrastructure/messaging/outbox-publisher.service.js';
import { ProcessWagerInput, ProcessWagerTransactionService } from './process-wager-transaction.service.js';
import { WagerConsumerService } from './wager-consumer.service.js';

@Injectable()
export class WagerWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WagerWorkerService.name);
  private stopping = false;
  private tasks: Promise<void>[] = [];

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly consumer: WagerConsumerService,
    private readonly publisher: OutboxPublisherService,
    private readonly processor: ProcessWagerTransactionService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === 'false') return;
    this.tasks = [
      this.loop(() => this.consumer.processAvailable(), 1000),
      this.loop(() => this.publisher.publishBatch(), 1000),
      this.loop(() => this.retryReference(), 1000),
    ];
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.tasks);
  }

  private async loop(work: () => Promise<unknown>, delay: number): Promise<void> {
    while (!this.stopping) {
      try { await work(); } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error.code === '40P01' || error.code === '55P03' || error.code === '40001')) this.metrics?.increment('lockConflicts');
        this.logger.error(JSON.stringify({ message: 'worker failed', error: error instanceof Error ? error.message : 'unknown' }));
      }
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private async retryReference(): Promise<void> {
    await this.em.transactional(async (tx) => {
      // Acquire the wallet before the pending transaction, as in normal processing.
      const wallets = await tx.execute<{ id: string }[]>(
        `select w.id from wallets w where exists (
           select 1 from wager_transactions t where t.wallet_id = w.id
             and t.status = 'PENDING_REFERENCE' and t.next_reference_attempt_at <= now()
         ) order by w.id for no key update of w skip locked limit 1`,
      );
      if (!wallets[0]) return;
      const rows = await tx.execute<Record<string, unknown>[]>(
        `select * from wager_transactions where status = 'PENDING_REFERENCE'
         and next_reference_attempt_at <= now() and wallet_id = ? order by next_reference_attempt_at, id
         for update skip locked limit 1`, [wallets[0].id],
      );
      const row = rows[0];
      if (!row) return;
      const input: ProcessWagerInput = {
        providerId: String(row.provider_id), externalTransactionId: String(row.external_transaction_id),
        idempotencyKey: String(row.idempotency_key), playerId: String(row.player_id), walletId: String(row.wallet_id),
        roundId: String(row.round_id), gameId: String(row.game_id), kind: row.kind as ProcessWagerInput['kind'],
        money: { amount: String(row.amount), currency: String(row.currency) },
        referenceExternalTransactionId: String(row.reference_external_transaction_id),
        correlationId: typeof row.correlation_id === 'string' ? row.correlation_id : String(row.id),
        causationId: typeof row.causation_id === 'string' ? row.causation_id : undefined,
      };
      await this.processor.execute(input, tx, String(row.id));
    });
  }
}
