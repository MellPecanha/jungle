import { Module } from '@nestjs/common';
import { WageringController } from './wagering.controller.js';
import { WageringServicesModule } from './wagering-services.module.js';

@Module({
  imports: [WageringServicesModule],
  controllers: [WageringController],
})
export class WageringTransactionsModule {}
