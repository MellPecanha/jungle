import { Module } from '@nestjs/common';
import { ProviderIdentityGuard } from '../../common/auth/provider-identity.guard.js';
import { OutboxPublisherService } from '../../infrastructure/messaging/outbox-publisher.service.js';
import { ProcessWagerTransactionService } from './process-wager-transaction.service.js';
import { WagerConsumerService } from './wager-consumer.service.js';
import { WagerQueryService } from './wager-query.service.js';
import { WagerWorkerService } from './wager-worker.service.js';

@Module({
  providers: [
    ProviderIdentityGuard,
    ProcessWagerTransactionService,
    WagerQueryService,
    WagerConsumerService,
    WagerWorkerService,
    OutboxPublisherService,
  ],
  exports: [ProviderIdentityGuard, ProcessWagerTransactionService, WagerQueryService],
})
export class WageringServicesModule {}
