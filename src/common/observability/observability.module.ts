import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { InfrastructureExceptionFilter } from '../filters/infrastructure-exception.filter.js';
import { HttpMetricsInterceptor } from './http-metrics.interceptor.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, { provide: APP_FILTER, useClass: InfrastructureExceptionFilter }, { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor }],
  exports: [MetricsService],
})
export class ObservabilityModule {}
