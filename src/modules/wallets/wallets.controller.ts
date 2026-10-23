import { ProviderIdentityGuard } from '../../common/auth/provider-identity.guard.js';
import { Body, Controller, Get, UseGuards, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { OpenWalletService } from './open-wallet.service.js';
import type { OpenWalletInput } from './open-wallet.service.js';
import { WalletQueryService } from './wallet-query.service.js';

@UseGuards(ProviderIdentityGuard)
@ApiTags('Wallets')
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWalletService,
    private readonly queries: WalletQueryService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Cria uma carteira' })
  @ApiBody({ schema: { example: { playerId: 'player-123', initialBalance: { amount: '100.00', currency: 'BRL' } } } })
  open(@Body() input: OpenWalletInput) {
    return this.openWallet.execute(input);
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Consulta uma carteira' })
  @ApiParam({ name: 'walletId', example: 'wallet-123' })
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'Lista o ledger paginado de uma carteira' })
  @ApiParam({ name: 'walletId', example: 'wallet-123' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.queries.getLedger(walletId, cursor, limit ? Number(limit) : 50);
  }

  @Post(':walletId/reconciliation')
  @ApiOperation({ summary: 'Reconcilia o saldo materializado com o ledger' })
  @ApiParam({ name: 'walletId', example: 'wallet-123' })
  reconcile(@Param('walletId') walletId: string) {
    return this.queries.reconcile(walletId);
  }
}
