import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ObservabilityModule } from './common/observability/observability.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { WalletsModule } from './modules/wallets/wallets.module.js';
import { WageringModule } from './modules/wagering/wagering.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), InfrastructureModule, ObservabilityModule, HealthModule, WalletsModule, WageringModule],
})
export class AppModule {}
