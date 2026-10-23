import { describe, expect, it } from 'bun:test';
import { Money } from '../../../../src/common/money/money.js';

describe('Money', () => {
  it('keeps exact two-decimal values', () => {
    const money = Money.from({ amount: '10.10', currency: 'BRL' });

    expect(money.toJSON()).toEqual({ amount: '10.10', currency: 'BRL' });
    expect(money.toString()).toBe('10.10 BRL');
  });

  it('performs decimal arithmetic without floating-point rounding', () => {
    const left = Money.from({ amount: '0.10', currency: 'BRL' });
    const right = Money.from({ amount: '0.20', currency: 'BRL' });

    expect(left.add(right).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });

  it('returns new instances for operations', () => {
    const original = Money.from({ amount: '10.00', currency: 'BRL' });
    const result = original.subtract(Money.from({ amount: '3.00', currency: 'BRL' }));

    expect(original.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(result.toJSON()).toEqual({ amount: '7.00', currency: 'BRL' });
  });

  it('allows negative results only through domain operations', () => {
    const result = Money.zero('BRL').subtract(Money.from({ amount: '1.00', currency: 'BRL' }));

    expect(result.isNegative()).toBe(true);
    expect(result.negate().toJSON()).toEqual({ amount: '1.00', currency: 'BRL' });
  });

  it('rejects malformed, negative, and scientific amounts', () => {
    for (const amount of ['', '-1.00', '1', '1.0', '1.000', '1e2', 'NaN', 'Infinity']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
    }
  });

  it('rejects operations across currencies', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow();
    expect(() => brl.subtract(usd)).toThrow();
    expect(() => brl.isLessThan(usd)).toThrow();
    expect(brl.equals(usd)).toBe(false);
  });
});
