import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ConflictException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import config from '../src/infrastructure/database/mikro-orm.config.js';
import { OpenWalletService } from '../src/modules/wallets/open-wallet.service.js';
import { ProcessWagerTransactionService, type ProcessWagerInput } from '../src/modules/wagering/process-wager-transaction.service.js';
import { WagerWorkerService } from '../src/modules/wagering/wager-worker.service.js';
import { WagerTransactionKind } from '../src/modules/wagering/wager-transaction.js';

const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;
integration('financial integration (PostgreSQL)', () => {
  let orm: MikroORM;
  beforeAll(async () => { orm = await MikroORM.init(config); });
  afterAll(async () => { await orm?.close(); });
  async function expectReconciled(walletId: string) {
    const rows = await orm.em.fork().execute<{ balance: string; ledger: string }[]>(
      `select w.balance, coalesce((select sum(case when direction = 'CREDIT' then amount else -amount end)
       from wallet_ledger_entries where wallet_id = w.id), 0)::numeric(20,2) as ledger
       from wallets w where w.id = ?`, [walletId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.balance).toBe(rows[0]?.ledger);
  }

  it('serializes competing bets and returns the original balance on replay', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const base: ProcessWagerInput = {
      providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(),
      playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    };
    const first = new ProcessWagerTransactionService(orm.em.fork());
    const second = new ProcessWagerTransactionService(orm.em.fork());
    const results = await Promise.all([
      first.execute(base), second.execute({ ...base, idempotencyKey: randomUUID(), externalTransactionId: randomUUID() }),
    ]);
    expect(results.filter((x) => x.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((x) => x.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
    const rows = await orm.em.fork().execute<{ balance: string; ledger_balance: string; debits: string }[]>(
      `select w.balance, (select sum(case when direction = 'CREDIT' then amount else -amount end) from wallet_ledger_entries where wallet_id = w.id) as ledger_balance,
       (select count(*) from wallet_ledger_entries where wallet_id = w.id and direction = 'DEBIT') as debits from wallets w where id = ?`, [wallet.id],
    );
    expect(rows[0]?.balance).toBe('20.00');
    expect(rows[0]?.ledger_balance).toBe('20.00');
    expect(Number(rows[0]?.debits)).toBe(1);
    const replay = await first.execute(base);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(results[0]?.status);
    await expectReconciled(wallet.id);
  });

  it('deduplicates 50 concurrent requests and preserves the original replay balance', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input: ProcessWagerInput = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId,
      walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const results = await Promise.all(Array.from({ length: 50 }, () => new ProcessWagerTransactionService(orm.em.fork()).execute(input)));
    expect(results.filter((result) => !result.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    await new ProcessWagerTransactionService(orm.em.fork()).execute({ ...input, externalTransactionId: randomUUID(), idempotencyKey: randomUUID() });
    const replay = await new ProcessWagerTransactionService(orm.em.fork()).execute(input);
    expect(replay.balance?.amount).toBe('90.00');
    const entries = await orm.em.fork().execute<{ debits: string; balance: string }[]>(`select count(*) filter (where direction = 'DEBIT') as debits, sum(case when direction = 'CREDIT' then amount else -amount end) as balance from wallet_ledger_entries where wallet_id = ?`, [wallet.id]);
    expect(Number(entries[0]?.debits)).toBe(2);
    expect(entries[0]?.balance).toBe('80.00');
    await expectReconciled(wallet.id);
  });

  it('reports divergent idempotency payloads as conflicts before looking up the supplied wallet', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input: ProcessWagerInput = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId,
      walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const service = new ProcessWagerTransactionService(orm.em.fork());
    await service.execute(input);
    try {
      await service.execute({ ...input, walletId: randomUUID() });
      throw new Error('Expected divergent idempotency payload to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
    }
  });

  it('persists an auditable FAILED transaction for a permanent technical failure', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input: ProcessWagerInput = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId,
      walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const service = new ProcessWagerTransactionService(orm.em.fork());
    await service.recordPermanentFailure(input);
    const rows = await orm.em.fork().execute<{ status: string; failure_code: string; result_balance: string }[]>(
      `select status, failure_code, result_balance from wager_transactions where idempotency_key = ?`, [input.idempotencyKey],
    );
    expect(rows).toEqual([{ status: 'FAILED', failure_code: 'INTERNAL_ERROR', result_balance: '100.00' }]);
    expect(await service.execute(input)).toMatchObject({ status: 'FAILED', idempotentReplay: true });
    await expectReconciled(wallet.id);
  });

  it('applies a refund once and rejects a second reversal of the same type', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const bet: ProcessWagerInput = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId,
      walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const service = new ProcessWagerTransactionService(orm.em.fork());
    await service.execute(bet);
    const refund: ProcessWagerInput = { ...bet, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), kind: WagerTransactionKind.Refund, referenceExternalTransactionId: bet.externalTransactionId };
    expect((await service.execute(refund)).balance?.amount).toBe('100.00');
    expect((await service.execute({ ...refund, externalTransactionId: randomUUID(), idempotencyKey: randomUUID() })).failureCode).toBe('DUPLICATE_REVERSAL');
    await expectReconciled(wallet.id);
  });


  it('retries a refund that arrived before its bet', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const bet: ProcessWagerInput = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId,
      walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const refund: ProcessWagerInput = { ...bet, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), kind: WagerTransactionKind.Refund, referenceExternalTransactionId: bet.externalTransactionId };
    const service = new ProcessWagerTransactionService(orm.em.fork());
    const pending = await service.execute(refund);
    expect(pending.status).toBe('PENDING_REFERENCE');
    await service.execute(bet);
    await orm.em.fork().execute(`update wager_transactions set next_reference_attempt_at = now() - interval '1 second' where id = ?`, [pending.transactionId], 'run');
    const worker = new WagerWorkerService(orm.em.fork(), null as never, null as never, service);
    await (worker as unknown as { retryReference(): Promise<void> }).retryReference();
    const rows = await orm.em.fork().execute<{ status: string; balance: string }[]>(`select t.status, w.balance from wager_transactions t join wallets w on w.id = t.wallet_id where t.id = ?`, [pending.transactionId]);
    expect(rows[0]?.status).toBe('PROCESSED');
    expect(rows[0]?.balance).toBe('100.00');
    await expectReconciled(wallet.id);
  });

});
