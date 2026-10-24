import { queueUrls } from '../../config/queues.js';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { MetricsService } from '../../common/observability/metrics.service.js';
import { createHash } from 'node:crypto';
import { SqsClient } from '../../infrastructure/messaging/sqs.client.js';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject } from '@nestjs/common';
import { ProcessWagerTransactionService, ProcessWagerInput } from './process-wager-transaction.service.js';
import { InboxMessage } from '../idempotency/inbox-message.js';

@Injectable()
export class WagerConsumerService {
  private readonly logger = new Logger(WagerConsumerService.name);
  private readonly queueUrl = queueUrls().wagers;
  private readonly dlqUrl = queueUrls().deadLetters;
  private readonly consumerName = 'wager-processor';

  constructor(
    private readonly sqs: SqsClient,
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly processWager: ProcessWagerTransactionService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async processAvailable(): Promise<number> {
    const messages = await this.sqs.receive(this.queueUrl);
    for (const message of messages) {
      if (!message.MessageId || !message.Body || !message.ReceiptHandle) continue;
      const start = Date.now();
      const hash = createHash('sha256').update(message.Body).digest('hex');
      let context: { messageId: string; correlationId?: string; walletId?: string; providerId?: string; transactionId?: string } = { messageId: message.MessageId };
      let envelope: { messageId?: string; type?: string; occurredAt?: string; data: ProcessWagerInput } | undefined;
      try {
        try { envelope = JSON.parse(message.Body) as typeof envelope; }
        catch { throw new BadRequestException('Invalid message JSON'); }
        if (!envelope || typeof envelope.messageId !== 'string' || !envelope.messageId.trim() ||
          typeof envelope.occurredAt !== 'string' || !Number.isFinite(Date.parse(envelope.occurredAt)) ||
          envelope.type !== 'WagerTransactionRequested' || !envelope.data || typeof envelope.data !== 'object') {
          throw new BadRequestException('Invalid message envelope');
        }
        const command = envelope;
        const commandMessageId = command.messageId as string;
        context = { messageId: commandMessageId, correlationId: typeof command.data.correlationId === 'string' ? command.data.correlationId : commandMessageId, walletId: typeof command.data.walletId === 'string' ? command.data.walletId : undefined, providerId: typeof command.data.providerId === 'string' ? command.data.providerId : undefined };
        this.logger.log(JSON.stringify({ message: 'processing wager', ...context }));
        await this.em.transactional(async (tx) => {
          const inbox = InboxMessage.receive({ messageId: commandMessageId, consumerName: this.consumerName, payloadHash: hash, receivedAt: new Date() });
          const inserted = await tx.execute(
            `insert into inbox_messages (message_id, consumer_name, payload_hash, received_at)
             values (?, ?, ?, ?) on conflict (consumer_name, message_id) do nothing`,
            [inbox.messageId, inbox.consumerName, inbox.payloadHash, inbox.receivedAt], 'run',
          );
          if (this.affectedRows(inserted) === 0) {
            const rows = await tx.execute<{ payload_hash: string; processed_at: Date | null }[]>(
              `select payload_hash, processed_at from inbox_messages where consumer_name = ? and message_id = ?`,
              [this.consumerName, commandMessageId],
            );
            if (rows[0]?.payload_hash !== hash) throw new ConflictException('Inbox message conflict');
            if (!rows[0]?.processed_at) throw new Error('Inbox message not processed');
            this.metrics?.increment('duplicates');
            return;
          }
          const result = await this.processWager.execute({ ...command.data, correlationId: context.correlationId, causationId: commandMessageId }, tx);
          context.transactionId = result.transactionId;
          this.logger.log(JSON.stringify({ message: 'wager transaction staged', ...context, transactionId: result.transactionId, status: result.status }));
          inbox.markProcessed(new Date());
          await tx.execute(
            `update inbox_messages set processed_at = ? where message_id = ? and consumer_name = ?`,
            [inbox.processedAt, inbox.messageId, inbox.consumerName], 'run',
          );
        });
        await this.sqs.acknowledge(this.queueUrl, message.ReceiptHandle);
      } catch (error) {
        const permanentInfrastructure = this.isPermanentInfrastructureError(error);
        if (permanentInfrastructure && envelope?.data) {
          try {
            await this.processWager.recordPermanentFailure(envelope.data, this.em);
          } catch (auditError) {
            this.logger.error(JSON.stringify({ message: 'failed to record terminal technical failure', ...context, error: auditError instanceof Error ? auditError.message : 'unknown' }));
          }
        }
        const permanent = permanentInfrastructure || error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException;
        const attempts = Math.max(1, Number(message.Attributes?.ApproximateReceiveCount ?? 1));
        this.logger.error(JSON.stringify({ message: 'wager processing failed', ...context, transportMessageId: message.MessageId, permanent, attempts }));
        if (permanent) {
          // Send first: a crash before the ack can duplicate DLQ delivery but cannot lose the message.
          await this.sqs.sendToDlq(this.dlqUrl, message.Body, message.Attributes?.MessageGroupId ?? message.MessageId, message.MessageId);
          this.metrics?.increment('dlqMessages');
          await this.sqs.acknowledge(this.queueUrl, message.ReceiptHandle);
        } else {
          this.metrics?.increment('retries');
          await this.sqs.changeVisibility(this.queueUrl, message.ReceiptHandle, Math.min(300, 2 ** Math.min(attempts, 8)));
        }
      } finally {
        this.metrics?.increment('processingCount');
        this.metrics?.increment('processingMillisecondsTotal', Date.now() - start);
      }
    }
    return messages.length;
  }

  private affectedRows(result: unknown): number {
    return typeof result === 'object' && result !== null && 'affectedRows' in result
      ? Number(result.affectedRows)
      : 0;
  }

  private isPermanentInfrastructureError(error: unknown): boolean {
    let current = error;
    for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
      const code = (current as { code?: unknown }).code;
      // SQLSTATE classes 0A (unsupported feature) and 42 (syntax, schema or
      // authorization configuration) cannot be resolved by redelivery alone.
      if (typeof code === 'string' && (code.startsWith('0A') || code.startsWith('42'))) return true;
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  }
}
