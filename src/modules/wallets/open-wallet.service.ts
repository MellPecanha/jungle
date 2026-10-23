import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'node:crypto';

import { WalletBalanceChanged } from './wallet-events.js';
import { Money } from '../../common/money/money.js';
import { Wallet } from './wallet.js';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../ledger/wallet-ledger-entry.js';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: {
    amount: string;
    currency: string;
  };
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

@Injectable()
export class OpenWalletService {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletResult> {
    if (!input || typeof input.playerId !== 'string' || !input.playerId.trim() || !input.initialBalance) {
      throw new BadRequestException('Invalid wallet payload');
    }
    let initialBalance: Money;
    try { initialBalance = Money.from(input.initialBalance); }
    catch { throw new BadRequestException('Invalid initial balance'); }
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      initialBalance,
    });

    try {
      return await this.em.transactional(async (tx) => {
        await tx.execute(
          `insert into wallets
            (id, player_id, currency, balance, version, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
          [
            wallet.id,
            wallet.playerId,
            wallet.currency,
            wallet.balance.toJSON().amount,
            wallet.version,
            wallet.createdAt,
            wallet.updatedAt,
          ],
        );

        if (!initialBalance.isZero()) {
          const transactionId = randomUUID();
          const entry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(initialBalance.currency),
            balanceAfter: wallet.balance,
            createdAt: wallet.updatedAt,
          });
          const payloadHash = createHash('sha256')
            .update(`${wallet.id}:OPENING:${initialBalance.toString()}`)
            .digest('hex');

          await tx.execute(
            `insert into wager_transactions
              (id, provider_id, external_transaction_id, idempotency_key,
               payload_hash, wallet_id, player_id, round_id, game_id,
               kind, amount, currency, status, processed_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              transactionId,
              '__internal__',
              `OPENING:${wallet.id}`,
              `OPENING:${wallet.id}`,
              payloadHash,
              wallet.id,
              wallet.playerId,
              '__internal__',
              '__internal__',
              'OPENING',
              initialBalance.toJSON().amount,
              initialBalance.currency,
              'PROCESSED',
              wallet.updatedAt,
            ],
          );

          await tx.execute(
            `insert into wallet_ledger_entries
              (id, wallet_id, transaction_id, direction, amount, currency,
               balance_before, balance_after, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              entry.id,
              entry.walletId,
              entry.transactionId,
              entry.direction,
              entry.money.toJSON().amount,
              entry.money.currency,
              entry.balanceBefore.toJSON().amount,
              entry.balanceAfter.toJSON().amount,
              entry.createdAt,
            ],
          );
          const event = WalletBalanceChanged.from(wallet, entry, transactionId);
          await tx.execute(
            `insert into outbox_messages
              (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
             values (?, ?, ?, ?::jsonb, ?, ?)`,
            [
              event.eventId,
              wallet.id,
              'WalletBalanceChanged',
              JSON.stringify(event.toJSON()),
              wallet.updatedAt,
              wallet.updatedAt,
            ],
          );
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('A wallet already exists for this player and currency');
      }
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505';
  }
}
