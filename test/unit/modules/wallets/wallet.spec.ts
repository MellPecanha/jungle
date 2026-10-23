import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/common/money/money.js';
import { InsufficientFundsError, Wallet } from '../../../../src/modules/wallets/wallet.js';

describe('Wallet', () => {
  it('opens with an opening balance at version one', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
  });

  it('rejects a debit that would make the balance negative', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(() => wallet.debit(Money.from({ amount: '100.01', currency: 'BRL' })))
      .toThrow(InsufficientFundsError);
  });

  it('changes balance and version for a valid debit', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const change = wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }));

    expect(change.before.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(change.after.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);
  });
});
