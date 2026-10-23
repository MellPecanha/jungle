import { Money, type MoneyProps } from '../../common/money/money.js';
import { LedgerDirection } from '../ledger/wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

// These values are part of the integration contract and must not be renamed.
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReference = 'INVALID_REFERENCE',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  InvalidPayload = 'INVALID_PAYLOAD',
  InternalError = 'INTERNAL_ERROR',
}

export class InvalidTransactionStateError extends Error {
  constructor(status: WagerTransactionStatus, operation: string) {
    super(`Cannot ${operation} a ${status} transaction`);
    this.name = 'InvalidTransactionStateError';
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money | MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'money' | 'createdAt'> {
  money: Money | MoneyProps;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === undefined || props.kind === ('OPENING' as WagerTransactionKind)) {
      throw new Error('Opening transactions are internal');
    }
    const transaction = new WagerTransaction(
      props.id, props.providerId, props.externalTransactionId, props.idempotencyKey,
      props.payloadHash, props.walletId, props.playerId, props.roundId, props.gameId,
      props.kind, toMoney(props.money), props.referenceExternalTransactionId,
      props.createdAt ? new Date(props.createdAt) : new Date(), WagerTransactionStatus.Pending,
    );
    if (transaction.requiresReference() && !transaction.referenceExternalTransactionId) {
      throw new Error(`${transaction.kind} requires a reference`);
    }
    return transaction;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id, state.providerId, state.externalTransactionId, state.idempotencyKey,
      state.payloadHash, state.walletId, state.playerId, state.roundId, state.gameId,
      state.kind, toMoney(state.money), state.referenceExternalTransactionId,
      new Date(state.createdAt), state.status, state.referenceTransactionId,
      state.failureCode, state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('mark processed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at);
  }

  markPendingReference(): void {
    this.assertNotTerminal('mark pending reference');
    if (!this.requiresReference() && !(this.kind === WagerTransactionKind.Win && this.referenceExternalTransactionId)) {
      throw new Error(`${this.kind} does not require a reference`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  isTerminal(): boolean {
    return this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed;
  }

  affectsBalance(): boolean { return this.kind !== WagerTransactionKind.Loss; }
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (this.kind === WagerTransactionKind.Win || this.kind === WagerTransactionKind.Refund) {
      return LedgerDirection.Credit;
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!reference) throw new Error('Rollback requires a reference');
      if (!reference.affectsBalance()) throw new Error('Rollback reference has no ledger entry');
      return reference.ledgerDirectionFor() === LedgerDirection.Debit
        ? LedgerDirection.Credit : LedgerDirection.Debit;
    }
    throw new Error('LOSS does not affect the ledger');
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this._status, operation);
  }
}

function toMoney(value: Money | MoneyProps): Money {
  return value instanceof Money ? value : Money.from(value);
}

export { WagerTransactionKind as Kind, WagerTransactionStatus as Status };
export { LedgerDirection };
