import { IntegrationEvent, type IntegrationEventProps } from '../../common/events/integration-event.js';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';
import { Wallet } from './wallet.js';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static create(props: IntegrationEventProps<WalletBalanceChangedData>): WalletBalanceChanged { return new WalletBalanceChanged(props); }

  static from(wallet: Wallet, entry: WalletLedgerEntry, correlationId: string) {
    return new WalletBalanceChanged({
      aggregateId: wallet.id,
      correlationId,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
