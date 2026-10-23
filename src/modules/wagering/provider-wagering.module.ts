import { Module } from '@nestjs/common';
import { ProviderWageringController } from './provider-wagering.controller.js';
import { WageringServicesModule } from './wagering-services.module.js';

@Module({
  imports: [WageringServicesModule],
  controllers: [ProviderWageringController],
})
export class ProviderWageringModule {}
