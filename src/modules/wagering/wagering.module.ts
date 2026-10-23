import { Module } from '@nestjs/common';
import { ProviderWageringModule } from './provider-wagering.module.js';
import { WageringTransactionsModule } from './wagering-transactions.module.js';

@Module({
  imports: [WageringTransactionsModule, ProviderWageringModule],
})
export class WageringModule {}
