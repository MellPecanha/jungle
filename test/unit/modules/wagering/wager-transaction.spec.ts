import { describe, expect, test } from 'bun:test';
import { Money } from '../../../../src/common/money/money.js';
import {
  FailureCode,
  InvalidTransactionStateError,
  LedgerDirection,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../../src/modules/wagering/wager-transaction.js';

const make = (kind: Kind, referenceExternalTransactionId?: string) => WagerTransaction.create({
  id: 'id', providerId: 'provider', externalTransactionId: 'external',
  idempotencyKey: 'key', payloadHash: 'hash', walletId: 'wallet',
  playerId: 'player', roundId: 'round', gameId: 'game', kind,
  money: Money.from({ amount: '10.00', currency: 'BRL' }),
  referenceExternalTransactionId,
  createdAt: new Date('2026-01-01T00:00:00Z'),
});

describe('WagerTransaction', () => {
  test('creates pending transactions and enforces references', () => {
    expect(make(Kind.Bet).status).toBe(Status.Pending);
    expect(() => make(Kind.Refund)).toThrow();
    expect(() => make(Kind.Rollback)).toThrow();
    expect(() => make('OPENING' as Kind)).toThrow();
  });

  test('supports pending reference and processing', () => {
    const transaction = make(Kind.Refund, 'bet-external');
    transaction.markPendingReference();
    expect(transaction.status).toBe(Status.PendingReference);
    transaction.markProcessed('bet-id', new Date('2026-01-01T01:00:00Z'));
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.referenceTransactionId).toBe('bet-id');
    expect(transaction.processedAt?.toISOString()).toContain('01:00:00');
  });

  test('rejects and fails with stable failure codes, and terminal states are immutable', () => {
    const rejected = make(Kind.Bet);
    rejected.reject(FailureCode.InsufficientFunds);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => rejected.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);

    const failed = make(Kind.Win);
    failed.fail(FailureCode.InternalError);
    expect(failed.status).toBe(Status.Failed);
    expect(() => failed.reject(FailureCode.InvalidPayload)).toThrow(InvalidTransactionStateError);
  });

  test('reports balance behavior and ledger directions', () => {
    expect(make(Kind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(Kind.Loss).affectsBalance()).toBe(false);
    expect(() => make(Kind.Loss).ledgerDirectionFor()).toThrow();
    const bet = make(Kind.Bet);
    expect(make(Kind.Rollback, 'bet-external').ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    const refund = make(Kind.Refund, 'bet-external');
    expect(refund.requiresReference()).toBe(true);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make(Kind.Rollback, 'win-external').ledgerDirectionFor(make(Kind.Win))).toBe(LedgerDirection.Debit);
    expect(make(Kind.Rollback, 'refund-external').ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => make(Kind.Rollback, 'loss-external').ledgerDirectionFor(make(Kind.Loss))).toThrow();
  });

  test('matches payload and rehydrates without applying transitions', () => {
    const source = make(Kind.Bet);
    const transaction = WagerTransaction.rehydrate({
      id: source.id,
      providerId: source.providerId,
      externalTransactionId: source.externalTransactionId,
      idempotencyKey: source.idempotencyKey,
      payloadHash: source.payloadHash,
      walletId: source.walletId,
      playerId: source.playerId,
      roundId: source.roundId,
      gameId: source.gameId,
      kind: source.kind,
      money: source.money,
      referenceExternalTransactionId: source.referenceExternalTransactionId,
      createdAt: source.createdAt,
      status: Status.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
    });
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.matchesPayload('hash')).toBe(true);
    expect(transaction.matchesPayload('other')).toBe(false);
  });
});
