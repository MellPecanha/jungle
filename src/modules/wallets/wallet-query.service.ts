import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject } from '@nestjs/common';
import { MetricsService } from '../../common/observability/metrics.service.js';

@Injectable()
export class WalletQueryService {
  private readonly logger = new Logger(WalletQueryService.name);
  constructor(@Inject(EntityManager) private readonly em: EntityManager, @Optional() private readonly metrics?: MetricsService) {}

  async getWallet(id: string) {
    const rows = await this.em.execute<Record<string, unknown>[]>(`select id, player_id, balance, currency, version from wallets where id = ?`, [id]);
    const wallet = rows[0];
    if (!wallet) throw new NotFoundException('Wallet not found');
    return {
      id: String(wallet.id),
      playerId: String(wallet.player_id),
      balance: { amount: String(wallet.balance), currency: String(wallet.currency) },
      version: Number(wallet.version),
    };
  }

  async getLedger(walletId: string, cursor?: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Limit must be an integer between 1 and 100');
    const safeLimit = limit;
    const after = cursor ? this.decodeCursor(cursor) : undefined;
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `select id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at, created_at::text as cursor_created_at
       from wallet_ledger_entries
       where wallet_id = ? ${after ? 'and (created_at, id) < (?, ?)' : ''}
       order by created_at desc, id desc limit ?`,
      after ? [walletId, after.createdAt, after.id, safeLimit + 1] : [walletId, safeLimit + 1],
    );
    const hasMore = rows.length > safeLimit;
    const entries = rows.slice(0, safeLimit).map((row) => ({
      id: String(row.id),
      transactionId: String(row.transaction_id),
      direction: row.direction,
      money: { amount: String(row.amount), currency: String(row.currency) },
      balanceBefore: { amount: String(row.balance_before), currency: String(row.currency) },
      balanceAfter: { amount: String(row.balance_after), currency: String(row.currency) },
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    }));
    return {
      items: entries,
      nextCursor: hasMore && entries.length > 0
        ? Buffer.from(JSON.stringify({ createdAt: String(rows[safeLimit - 1]?.cursor_created_at), id: entries.at(-1)?.id })).toString('base64url')
        : undefined,
    };
  }

  async reconcile(walletId: string) {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `select w.balance::text as stored_balance, w.currency,
         coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calculated,
         (w.balance - coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0))::numeric(20,2)::text as difference,
         count(l.id) as checked_entries
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
       where w.id = ? group by w.id`, [walletId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Wallet not found');
    const currency = String(row.currency);
    const difference = String(row.difference);
    if (difference !== '0.00') {
      this.metrics?.increment('reconciliationDivergences');
      this.logger.error(JSON.stringify({ message: 'wallet reconciliation divergence', walletId }));
    }
    return {
      walletId,
      storedBalance: { amount: String(row.stored_balance), currency },
      calculatedBalance: { amount: String(row.calculated), currency },
      difference: { amount: difference, currency },
      consistent: difference === '0.00',
      checkedEntries: Number(row.checked_entries),
    };
  }

  private decodeCursor(cursor: string): { createdAt: string; id: string } {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
      if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.id !== 'string' || !value.id) throw new Error('invalid');
      return value as { createdAt: string; id: string };
    } catch {
      throw new BadRequestException('Invalid ledger cursor');
    }
  }

}
