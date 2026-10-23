import { Module } from '@nestjs/common';
import { ProviderIdentityGuard } from '../../common/auth/provider-identity.guard.js';
import { OpenWalletService } from './open-wallet.service.js';
import { WalletQueryService } from './wallet-query.service.js';
import { WalletsController } from './wallets.controller.js';

@Module({ controllers: [WalletsController], providers: [ProviderIdentityGuard, OpenWalletService, WalletQueryService] })
export class WalletsModule {}
