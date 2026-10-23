import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject } from '@nestjs/common';

@Injectable()
export class WagerQueryService {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async byId(id: string) {
    const rows = await this.em.execute<Record<string, unknown>[]>(`select * from wager_transactions where id = ?`, [id]);
    return this.map(rows[0]);
  }

  async byExternal(providerId: string, externalId: string) {
    const rows = await this.em.execute<Record<string, unknown>[]>(
      `select * from wager_transactions where provider_id = ? and external_transaction_id = ?`,
      [providerId, externalId],
    );
    return this.map(rows[0]);
  }

  private map(row: Record<string, unknown> | undefined) {
    if (!row) throw new NotFoundException('Transaction not found');
    return {
      transactionId: String(row.id),
      providerId: String(row.provider_id),
      externalTransactionId: String(row.external_transaction_id),
      walletId: String(row.wallet_id),
      playerId: String(row.player_id),
      roundId: String(row.round_id),
      gameId: String(row.game_id),
      kind: row.kind,
      status: row.status,
      money: { amount: String(row.amount), currency: String(row.currency) },
      referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
      failureCode: row.failure_code ?? undefined,
      processedAt: row.processed_at ? new Date(row.processed_at as string | Date).toISOString() : undefined,
    };
  }
}
