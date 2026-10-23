import { Money } from '../../common/money/money.js';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceChange {
  before: Money;
  after: Money;
}

export class InsufficientFundsError extends Error {
  constructor() {
    super('Wallet has insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    now?: Date;
  }): Wallet {
    if (props.id.length === 0 || props.playerId.length === 0) {
      throw new Error('Wallet id and playerId are required');
    }

    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, now = new Date()): BalanceChange {
    this.assertSameCurrency(money);

    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError();
    }

    const before = this._balance;
    this._balance = this._balance.subtract(money);
    this._version += 1;
    this._updatedAt = now;
    return { before, after: this._balance };
  }

  credit(money: Money, now = new Date()): BalanceChange {
    this.assertSameCurrency(money);

    const before = this._balance;
    this._balance = this._balance.add(money);
    this._version += 1;
    this._updatedAt = now;
    return { before, after: this._balance };
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new Error(`Currency mismatch: ${this.currency} and ${money.currency}`);
    }
  }
}
