import { ProviderIdentityGuard } from '../../common/auth/provider-identity.guard.js';
import { Controller, Get, UseGuards, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { WagerQueryService } from './wager-query.service.js';

@UseGuards(ProviderIdentityGuard)
@ApiTags('Wagering')
@Controller('providers')
export class ProviderWageringController {
  constructor(private readonly queries: WagerQueryService) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({ summary: 'Consulta uma transação pelo identificador externo do provedor' })
  @ApiParam({ name: 'providerId', example: 'provider-a' })
  @ApiParam({ name: 'externalTransactionId', example: 'bet-001' })
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.queries.byExternal(providerId, externalTransactionId);
  }
}
