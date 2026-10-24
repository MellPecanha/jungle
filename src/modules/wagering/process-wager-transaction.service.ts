import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'node:crypto';

import { MetricsService } from '../../common/observability/metrics.service.js';
import { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference } from './wager-events.js';
import { WalletBalanceChanged, type WalletBalanceChangedData } from '../wallets/wallet-events.js';
import { Money } from '../../common/money/money.js';
import { InsufficientFundsError, Wallet } from '../wallets/wallet.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry.js';

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  correlationId?: string;
  causationId?: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

@Injectable()
export class ProcessWagerTransactionService {
  constructor(@Inject(EntityManager) private readonly em: EntityManager, @Optional() private readonly metrics?: MetricsService) {}

  async execute(input: ProcessWagerInput, manager: EntityManager = this.em, pendingId?: string): Promise<ProcessWagerResult> {
    if (!input || typeof input !== 'object' ||
        !['providerId', 'externalTransactionId', 'idempotencyKey', 'playerId', 'walletId', 'roundId', 'gameId'].every(
          (key) => { const value = input[key as keyof ProcessWagerInput]; return typeof value === 'string' && value.trim().length > 0; },
        ) || ![WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss, WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(input.kind) ||
        !input.money || typeof input.money.amount !== 'string' || typeof input.money.currency !== 'string' ||
        (input.referenceExternalTransactionId !== undefined && (typeof input.referenceExternalTransactionId !== 'string' || !input.referenceExternalTransactionId.trim() || ![WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(input.kind))) ||
        ((input.kind === WagerTransactionKind.Refund || input.kind === WagerTransactionKind.Rollback) &&
          (typeof input.referenceExternalTransactionId !== 'string' || !input.referenceExternalTransactionId.trim()))) {
      throw new BadRequestException('Invalid transaction payload');
    }
    let money: Money;
    try { money = Money.from(input.money); } catch { throw new BadRequestException('Invalid money'); }
    if (money.isZero()) throw new BadRequestException('Transaction amount must be positive');
    const payloadHash = this.hashPayload(input);
    let transaction = WagerTransaction.create({
      id: pendingId ?? randomUUID(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    try {
      const context = { correlationId: input.correlationId ?? transaction.id, causationId: input.causationId };
      return await manager.transactional(async (tx) => {
        if (!pendingId) {
          const existingByKey = await this.findByIdempotency(tx, input.idempotencyKey);
          if (existingByKey) {
            return this.replayOrConflict(existingByKey, input, payloadHash);
          }
        }
        const wallet = await this.findWalletForUpdate(tx, input.walletId);
        if (!wallet) throw new NotFoundException('Wallet not found');
        if (pendingId) {
          const pending = await tx.execute<Record<string, unknown>[]>(
            `select * from wager_transactions where id = ? and wallet_id = ? and status = 'PENDING_REFERENCE' for update`,
            [pendingId, input.walletId],
          );
          if (!pending[0]) throw new Error('Pending transaction no longer available');
          transaction = this.referenceAsDomain(pending[0]);
        }
        const inserted = pendingId ? { affectedRows: 1 } : await tx.execute(
          `insert into wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency,
             reference_external_transaction_id, correlation_id, causation_id, status)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
           on conflict do nothing`,
          [
            transaction.id, transaction.providerId, transaction.externalTransactionId,
            transaction.idempotencyKey, transaction.payloadHash, transaction.walletId,
            transaction.playerId, transaction.roundId, transaction.gameId,
            transaction.kind, money.toJSON().amount, money.currency,
            transaction.referenceExternalTransactionId ?? null, input.correlationId ?? transaction.id, input.causationId ?? null,
          ],
          'run',
        );

        if (this.affectedRows(inserted) === 0) {
          const existing = await this.findByIdempotency(tx, input.idempotencyKey);
          if (!existing) {
            throw new ConflictException('Transaction identity conflicts with an existing operation');
          }
          return this.replayOrConflict(existing, input, payloadHash);
        }

        if (wallet.player_id !== input.playerId || wallet.currency !== money.currency) {
          await this.reject(tx, transaction, FailureCode.InvalidPayload, context);
          return {
            transactionId: transaction.id,
            status: WagerTransactionStatus.Rejected,
            idempotentReplay: false,
            failureCode: FailureCode.InvalidPayload,
          };
        }

        let reference: Record<string, unknown> | undefined;
        if (transaction.requiresReference() || (transaction.kind === WagerTransactionKind.Win && input.referenceExternalTransactionId)) {
          reference = await this.findReference(tx, input.providerId, input.referenceExternalTransactionId);
          if (!reference || reference.status === WagerTransactionStatus.Pending || reference.status === WagerTransactionStatus.PendingReference) {
            if (pendingId) {
              const rows = await tx.execute<{ reference_attempts: number }[]>(`select reference_attempts from wager_transactions where id = ?`, [pendingId]);
              if ((rows[0]?.reference_attempts ?? 0) >= 8) {
                await this.reject(tx, transaction, FailureCode.ReferenceNotFound, context);
                return { transactionId: transaction.id, status: WagerTransactionStatus.Rejected, idempotentReplay: false, failureCode: FailureCode.ReferenceNotFound };
              }
            }
            transaction.markPendingReference();
            await this.markPendingReference(tx, transaction.id);
            if (!pendingId) await this.enqueueEvent(tx, transaction.id, 'WagerTransactionPendingReference', {
              transactionId: transaction.id,
              referenceExternalTransactionId: input.referenceExternalTransactionId,
            }, context);
            return {
              transactionId: transaction.id,
              status: WagerTransactionStatus.PendingReference,
              idempotentReplay: false,
            };
          }
          if (!this.validReference(transaction, reference)) {
            await this.reject(tx, transaction, FailureCode.InvalidReference, context);
            return {
              transactionId: transaction.id,
              status: WagerTransactionStatus.Rejected,
              idempotentReplay: false,
              failureCode: FailureCode.InvalidReference,
            };
          }
          const reversed = transaction.requiresReference() ? await this.findReversal(tx, transaction.kind, String(reference.id)) : undefined;
          if (reversed) {
            await this.reject(tx, transaction, FailureCode.DuplicateReversal, context);
            return {
              transactionId: transaction.id,
              status: WagerTransactionStatus.Rejected,
              idempotentReplay: false,
              failureCode: FailureCode.DuplicateReversal,
            };
          }
        }

        if (transaction.kind === WagerTransactionKind.Loss) {
          await this.markProcessed(tx, transaction, reference?.id as string | undefined, String(wallet.balance));
          await this.enqueueEvent(tx, transaction.id, 'WagerTransactionProcessed', {
            transactionId: transaction.id,
            walletId: input.walletId,
            kind: transaction.kind,
          }, context);
          return { transactionId: transaction.id, status: WagerTransactionStatus.Processed, idempotentReplay: false, balance: this.walletBalance(wallet) };
        }

        const direction = transaction.ledgerDirectionFor(
          reference ? this.referenceAsDomain(reference) : undefined,
        );
        const aggregate = Wallet.rehydrate({
          id: String(wallet.id), playerId: String(wallet.player_id), currency: String(wallet.currency),
          balance: Money.from({ amount: String(wallet.balance), currency: String(wallet.currency) }),
          version: Number(wallet.version), createdAt: new Date(wallet.created_at as string | Date),
          updatedAt: new Date(wallet.updated_at as string | Date),
        });
        let change: { before: Money; after: Money };
        try {
          change = direction === LedgerDirection.Debit ? aggregate.debit(money) : aggregate.credit(money);
        } catch (error) {
          if (!(error instanceof InsufficientFundsError)) throw error;
          const code = transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.ReversalInsufficientFunds;
          await this.reject(tx, transaction, code, context);
          await tx.execute(`update wager_transactions set result_balance = ? where id = ?`, [String(wallet.balance), transaction.id], 'run');
          return { transactionId: transaction.id, status: WagerTransactionStatus.Rejected, idempotentReplay: false, failureCode: code, balance: this.walletBalance(wallet) };
        }

        const { before, after } = change;
        const version = aggregate.version;
        await tx.execute(
          `update wallets set balance = ?, version = ?, updated_at = now() where id = ?`,
          [after.toJSON().amount, version, input.walletId],
          'run',
        );
        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: input.walletId,
          transactionId: transaction.id,
          direction,
          money,
          balanceBefore: before,
          balanceAfter: after,
          createdAt: new Date(),
        });
        await tx.execute(
          `insert into wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [entry.id, entry.walletId, entry.transactionId, entry.direction,
            money.toJSON().amount, money.currency, before.toJSON().amount,
            after.toJSON().amount, entry.createdAt],
          'run',
        );
        await this.markProcessed(tx, transaction, reference?.id as string | undefined, after.toJSON().amount);
        await this.enqueueEvent(tx, transaction.id, 'WagerTransactionProcessed', {
          transactionId: transaction.id,
          walletId: input.walletId,
          kind: transaction.kind,
        }, context);
        await this.enqueueEvent(tx, input.walletId, 'WalletBalanceChanged', {
          walletId: input.walletId,
          transactionId: transaction.id,
          direction,
          money: money.toJSON(),
          balanceBefore: before.toJSON(),
          balanceAfter: after.toJSON(),
          walletVersion: version,
        }, context);
        return {
          transactionId: transaction.id,
          status: WagerTransactionStatus.Processed,
          balance: after.toJSON(),
          idempotentReplay: false,
        };
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && ['40P01', '55P03', '40001'].includes(String(error.code))) this.metrics?.increment('lockConflicts');
      if (error instanceof ConflictException || this.isUniqueViolation(error)) {
        throw new ConflictException('Transaction identity conflicts with an existing operation');
      }
      throw error;
    }
  }

  /**
   * Best-effort audit trail for a technical failure which is known to be
   * permanent (for example an incompatible database schema). Transient
   * failures must never use this path because they remain eligible for retry.
   */
  async recordPermanentFailure(input: ProcessWagerInput, manager: EntityManager = this.em): Promise<void> {
    let money: Money;
    try { money = Money.from(input.money); } catch { return; }
    if (money.isZero()) return;
    await manager.transactional(async (tx) => {
      if (await this.findByIdempotency(tx, input.idempotencyKey)) return;
      const wallet = await this.findWalletForUpdate(tx, input.walletId);
      if (!wallet || wallet.player_id !== input.playerId || wallet.currency !== money.currency) return;
      const payloadHash = this.hashPayload(input);
      await tx.execute(
        `insert into wager_transactions
          (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency,
           reference_external_transaction_id, correlation_id, causation_id,
           status, failure_code, processed_at, result_balance)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FAILED', ?, now(), ?)
         on conflict do nothing`,
        [
          randomUUID(), input.providerId, input.externalTransactionId, input.idempotencyKey,
          payloadHash, input.walletId, input.playerId, input.roundId, input.gameId,
          input.kind, money.toJSON().amount, money.currency,
          input.referenceExternalTransactionId ?? null, input.correlationId ?? null,
          input.causationId ?? null, FailureCode.InternalError, String(wallet.balance),
        ],
        'run',
      );
    });
  }

  private hashPayload(input: ProcessWagerInput): string {
    const canonical = JSON.stringify({
      externalTransactionId: input.externalTransactionId,
      gameId: input.gameId, kind: input.kind, money: { amount: input.money.amount, currency: input.money.currency },
      playerId: input.playerId, providerId: input.providerId, referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
      roundId: input.roundId, walletId: input.walletId,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private legacyHashPayload(input: ProcessWagerInput): string {
    const canonical = JSON.stringify({
      gameId: input.gameId,
      kind: input.kind,
      money: { amount: input.money.amount, currency: input.money.currency },
      playerId: input.playerId,
      providerId: input.providerId,
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
      roundId: input.roundId,
      walletId: input.walletId,
      externalTransactionId: input.externalTransactionId,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  private async findWalletForUpdate(tx: EntityManager, id: string) {
    const rows = await tx.execute<Record<string, unknown>[]>(`select * from wallets where id = ? for no key update`, [id]);
    return rows[0];
  }

  private async findByIdempotency(tx: EntityManager, key: string) {
    const rows = await tx.execute<Record<string, unknown>[]>(
      `select t.*, t.result_balance as balance, t.currency as wallet_currency from wager_transactions t
       where t.idempotency_key = ?`,
      [key],
    );
    return rows[0];
  }

  private replayOrConflict(existing: Record<string, unknown>, input: ProcessWagerInput, payloadHash: string): ProcessWagerResult {
    if (existing.payload_hash !== payloadHash && existing.payload_hash !== this.legacyHashPayload(input)) {
      throw new ConflictException('Idempotency key was reused with a different payload');
    }
    this.metrics?.increment('idempotentReplays');
    return this.toResult(existing, true);
  }

  private async findReference(tx: EntityManager, providerId: string, externalId?: string) {
    if (!externalId) return undefined;
    const rows = await tx.execute<Record<string, unknown>[]>(
      `select * from wager_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalId],
    );
    return rows[0];
  }

  private async findReversal(tx: EntityManager, kind: WagerTransactionKind, referenceId: string) {
    const rows = await tx.execute<Record<string, unknown>[]>(
      `select id from wager_transactions where kind = ? and reference_transaction_id = ? and status = 'PROCESSED'`,
      [kind, referenceId],
    );
    return rows[0];
  }

  private validReference(transaction: WagerTransaction, reference: Record<string, unknown>): boolean {
    const allowed = transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Win
      ? reference.kind === WagerTransactionKind.Bet
      : [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund].includes(reference.kind as WagerTransactionKind);
    return allowed && reference.status === WagerTransactionStatus.Processed &&
      reference.wallet_id === transaction.walletId &&
      reference.player_id === transaction.playerId &&
      reference.round_id === transaction.roundId &&
      reference.currency === transaction.money.currency &&
      (transaction.kind === WagerTransactionKind.Win || String(reference.amount) === transaction.money.toJSON().amount);
  }

  private referenceAsDomain(reference: Record<string, unknown>): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: String(reference.id),
      providerId: String(reference.provider_id),
      externalTransactionId: String(reference.external_transaction_id),
      idempotencyKey: String(reference.idempotency_key),
      payloadHash: String(reference.payload_hash),
      walletId: String(reference.wallet_id),
      playerId: String(reference.player_id),
      roundId: String(reference.round_id),
      gameId: String(reference.game_id),
      kind: reference.kind as WagerTransactionKind,
      money: { amount: String(reference.amount), currency: String(reference.currency) },
      referenceExternalTransactionId: reference.reference_external_transaction_id as string | undefined,
      createdAt: new Date(String(reference.created_at)),
      status: reference.status as WagerTransactionStatus,
      processedAt: reference.processed_at ? new Date(reference.processed_at as string | Date) : undefined,
    });
  }

  private async markPendingReference(tx: EntityManager, id: string) {
    await tx.execute(`update wager_transactions set status = 'PENDING_REFERENCE', reference_attempts = reference_attempts + 1, next_reference_attempt_at = now() + (least(300, power(2, least(reference_attempts + 1, 8))) * interval '1 second') where id = ?`, [id], 'run');
  }

  private async markProcessed(tx: EntityManager, transaction: WagerTransaction, referenceId: string | undefined, balance: string) {
    transaction.markProcessed(referenceId, new Date());
    await tx.execute(
      `update wager_transactions set status = ?, reference_transaction_id = ?, result_balance = ?, processed_at = ? where id = ?`,
      [transaction.status, transaction.referenceTransactionId ?? null, balance, transaction.processedAt, transaction.id],
      'run',
    );
  }

  private async reject(tx: EntityManager, transaction: WagerTransaction, code: FailureCode, context: { correlationId: string; causationId?: string }) {
    transaction.reject(code);
    await tx.execute(
      `update wager_transactions set status = ?, failure_code = ? where id = ?`,
      [transaction.status, transaction.failureCode, transaction.id],
      'run',
    );
    await this.enqueueEvent(tx, transaction.id, 'WagerTransactionRejected', { transactionId: transaction.id, failureCode: code }, context);
  }

  private async enqueueEvent(tx: EntityManager, aggregateId: string, eventType: 'WagerTransactionProcessed' | 'WagerTransactionRejected' | 'WagerTransactionPendingReference' | 'WalletBalanceChanged', data: Record<string, unknown>, context: { correlationId: string; causationId?: string }) {
    const props = { aggregateId, ...context, data };
    const event = eventType === 'WagerTransactionProcessed' ? WagerTransactionProcessed.create(props)
      : eventType === 'WagerTransactionRejected' ? WagerTransactionRejected.create(props)
      : eventType === 'WagerTransactionPendingReference' ? WagerTransactionPendingReference.create(props)
      : WalletBalanceChanged.create({ ...props, data: data as unknown as WalletBalanceChangedData });
    await tx.execute(
      `insert into outbox_messages
        (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
       values (?, ?, ?, ?::jsonb, now(), now())`,
      [event.eventId, aggregateId, event.eventType, JSON.stringify(event.toJSON())],
      'run',
    );
  }

  private affectedRows(result: unknown): number {
    if (typeof result === 'object' && result !== null && 'affectedRows' in result) {
      return Number(result.affectedRows);
    }
    return 0;
  }

  private walletBalance(wallet: Record<string, unknown>) {
    return { amount: String(wallet.balance), currency: String(wallet.currency) };
  }

  private toResult(row: Record<string, unknown>, replay: boolean): ProcessWagerResult {
    return {
      transactionId: String(row.id),
      status: row.status as WagerTransactionStatus,
      balance: row.balance === null || row.balance === undefined
        ? undefined
        : { amount: String(row.balance as string | number), currency: String(row.wallet_currency) },
      idempotentReplay: replay,
      ...(row.failure_code ? { failureCode: row.failure_code as FailureCode } : {}),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
  }
}
