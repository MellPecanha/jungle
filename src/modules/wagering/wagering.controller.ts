import { ProviderIdentityGuard } from '../../common/auth/provider-identity.guard.js';
import { BadRequestException, Body, Controller, Get, UseGuards, Headers, Param, Post, Res } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ProcessWagerInput, ProcessWagerTransactionService } from './process-wager-transaction.service.js';
import type { Response } from 'express';
import { WagerQueryService } from './wager-query.service.js';

@UseGuards(ProviderIdentityGuard)
@ApiTags('Wagering')
@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransactionService,
    private readonly queries: WagerQueryService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Processa BET, WIN, LOSS, REFUND ou ROLLBACK' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, example: 'provider-a:bet-001' })
  @ApiBody({ schema: { example: { providerId: 'provider-a', externalTransactionId: 'bet-001', playerId: 'player-123', walletId: 'wallet-123', roundId: 'round-001', gameId: 'game-001', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } } } })
  async process(
    @Body() input: Omit<ProcessWagerInput, 'idempotencyKey'>,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Res({ passthrough: true }) response?: Response,
  ) {
    if (!idempotencyKey?.trim()) throw new BadRequestException('Idempotency-Key is required');
    const result = await this.processWager.execute({
      ...input,
      idempotencyKey,
    });
    response?.status(result.status === 'PENDING_REFERENCE' || result.status === 'PENDING' ? 202 : result.status === 'REJECTED' ? 422 : result.status === 'FAILED' ? 503 : 200);
    return result;
  }

  @Get(':transactionId')
  @ApiOperation({ summary: 'Consulta uma transação pelo identificador interno' })
  @ApiParam({ name: 'transactionId', example: 'transaction-123' })
  get(@Param('transactionId') transactionId: string) {
    return this.queries.byId(transactionId);
  }
}
