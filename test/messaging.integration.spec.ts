import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MetricsController } from '../src/common/observability/metrics.controller.js';
import { MetricsService } from '../src/common/observability/metrics.service.js';
import { InfrastructureExceptionFilter } from '../src/common/filters/infrastructure-exception.filter.js';
import { WalletsController } from '../src/modules/wallets/wallets.controller.js';
import { WalletQueryService } from '../src/modules/wallets/wallet-query.service.js';
import { WageringController } from '../src/modules/wagering/wagering.controller.js';
import { WagerQueryService } from '../src/modules/wagering/wager-query.service.js';
import { Migrator } from '@mikro-orm/migrations';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'node:crypto';
import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import config from '../src/infrastructure/database/mikro-orm.config.js';
import { SqsClient } from '../src/infrastructure/messaging/sqs.client.js';
import { OpenWalletService } from '../src/modules/wallets/open-wallet.service.js';
import { WagerConsumerService } from '../src/modules/wagering/wager-consumer.service.js';
import { ProcessWagerTransactionService } from '../src/modules/wagering/process-wager-transaction.service.js';
import { WagerWorkerService } from '../src/modules/wagering/wager-worker.service.js';
import { WagerTransactionKind } from '../src/modules/wagering/wager-transaction.js';
import { OutboxPublisherService } from '../src/infrastructure/messaging/outbox-publisher.service.js';

const integration = process.env.RUN_INTEGRATION === 'true' ? describe : describe.skip;
integration('messaging integration (PostgreSQL and SQS)', () => {
  let admin: MikroORM;
  let orm: MikroORM;
  let mainQueue: string;
  let dlq: string;
  let events: string;
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const sqs = new SQSClient({ region: 'us-east-1', endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const oldEnv = { ...process.env };

  beforeAll(async () => {
    admin = await MikroORM.init(config);
    await admin.em.fork().execute(`create schema "${schema}"`);
    orm = await MikroORM.init({ ...config, schema, driverOptions: { options: `-c search_path=${schema}` }, migrations: { ...config.migrations, schema } });
    await new Migrator(orm.em).up();
    const suffix = randomUUID();
    const create = async (prefix: string) => (await sqs.send(new CreateQueueCommand({ QueueName: `${prefix}-${suffix}.fifo`, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' } }))).QueueUrl!;
    dlq = await create('dlq'); mainQueue = await create('wagers'); events = await create('events');
    const arn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }))).Attributes?.QueueArn;
    await sqs.send(new SetQueueAttributesCommand({ QueueUrl: mainQueue, Attributes: { RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '2' }) } }));
    process.env.WAGER_QUEUE_URL = mainQueue; process.env.WAGER_DLQ_URL = dlq; process.env.EVENT_QUEUE_URL = events;
  }, 30000);
  afterAll(async () => {
    for (const url of [mainQueue, dlq, events]) if (url) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
    await orm?.close();
    if (admin) { await admin.em.fork().execute(`drop schema if exists "${schema}" cascade`); await admin.close(); }
    for (const key of ['WAGER_QUEUE_URL', 'WAGER_DLQ_URL', 'EVENT_QUEUE_URL']) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
    sqs.destroy();
  }, 30000);

  it('redelivers after commit and before ack without a second debit', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const messageId = randomUUID();
    const body = JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: {
      providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId, walletId: wallet.id,
      roundId: randomUUID(), gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
    } });
    await sqs.send(new SendMessageCommand({ QueueUrl: mainQueue, MessageBody: body, MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID() }));
    class AckFailure extends SqsClient {
      override async acknowledge(): Promise<void> { throw new Error('simulated crash before ack'); }
      override async changeVisibility(queue: string, handle: string): Promise<void> { await super.changeVisibility(queue, handle, 0); }
    }
    await new WagerConsumerService(new AckFailure(), orm.em.fork(), new ProcessWagerTransactionService(orm.em.fork())).processAvailable();
    await new WagerConsumerService(new SqsClient(), orm.em.fork(), new ProcessWagerTransactionService(orm.em.fork())).processAvailable();
    const rows = await orm.em.fork().execute<{ balance: string; debits: string; inbox: string }[]>(`select w.balance,
      (select count(*) from wallet_ledger_entries where wallet_id = w.id and direction = 'DEBIT') as debits,
      (select count(*) from inbox_messages where message_id = ? and processed_at is not null) as inbox from wallets w where id = ?`, [messageId, wallet.id]);
    expect(rows[0]?.balance).toBe('75.00'); expect(Number(rows[0]?.debits)).toBe(1); expect(Number(rows[0]?.inbox)).toBe(1);
  }, 30000);

  it('rolls back inbox, wallet, ledger and outbox when a queued wager fails', async () => {
    const em = orm.em.fork();
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(em).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const messageId = randomUUID();
    const externalTransactionId = randomUUID();
    const body = JSON.stringify({ messageId, type: 'WagerTransactionRequested', data: {
      providerId: randomUUID(), externalTransactionId, idempotencyKey: randomUUID(), playerId, walletId: wallet.id,
      roundId: randomUUID(), gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
    } });
    const before = await em.execute<{ count: string }[]>(`select count(*) as count from outbox_messages`);
    await em.execute(`create function fail_wager_outbox() returns trigger language plpgsql as $$ begin raise exception 'test wager failure'; end; $$`);
    await em.execute(`create trigger fail_wager_outbox before insert on outbox_messages for each row execute function fail_wager_outbox()`);
    class ImmediateRetry extends SqsClient {
      override async changeVisibility(queue: string, handle: string): Promise<void> { await super.changeVisibility(queue, handle, 0); }
    }
    try {
      await sqs.send(new SendMessageCommand({ QueueUrl: mainQueue, MessageBody: body, MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID() }));
      await new WagerConsumerService(new ImmediateRetry(), em, new ProcessWagerTransactionService(em)).processAvailable();
      const rows = await em.execute<{ balance: string; ledger: string; inbox: string; transactions: string; outbox: string }[]>(`select w.balance,
        (select sum(case when direction = 'CREDIT' then amount else -amount end) from wallet_ledger_entries where wallet_id = w.id) as ledger,
        (select count(*) from inbox_messages where message_id = ?) as inbox,
        (select count(*) from wager_transactions where external_transaction_id = ?) as transactions,
        (select count(*) from outbox_messages) as outbox from wallets w where w.id = ?`, [messageId, externalTransactionId, wallet.id]);
      expect(rows[0]?.balance).toBe('100.00'); expect(rows[0]?.ledger).toBe('100.00');
      expect(Number(rows[0]?.inbox)).toBe(0); expect(Number(rows[0]?.transactions)).toBe(0);
      expect(rows[0]?.outbox).toBe(before[0]?.count);
    } finally {
      await em.execute(`drop trigger fail_wager_outbox on outbox_messages`);
      await em.execute(`drop function fail_wager_outbox()`);
    }
    await new WagerConsumerService(new SqsClient(), em, new ProcessWagerTransactionService(em)).processAvailable();
    const reconciliation = await new WalletQueryService(em).reconcile(wallet.id);
    expect(reconciliation.consistent).toBe(true); expect(reconciliation.storedBalance.amount).toBe('75.00');
  }, 30000);

  it('routes an invalid message to the DLQ', async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: mainQueue, MessageBody: '{bad json', MessageGroupId: randomUUID(), MessageDeduplicationId: randomUUID() }));
    await new WagerConsumerService(new SqsClient(), orm.em.fork(), new ProcessWagerTransactionService(orm.em.fork())).processAvailable();
    const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 2 }));
    expect(result.Messages?.[0]?.Body).toBe('{bad json');
  }, 30000);

  it('publishes the same outbox concurrently without losing events', async () => {
    const before = await orm.em.fork().execute<{ count: string }[]>(`select count(*) as count from outbox_messages where published_at is null`);
    const publishers = [new OutboxPublisherService(orm.em.fork(), new SqsClient()), new OutboxPublisherService(orm.em.fork(), new SqsClient())];
    const counts = await Promise.all(publishers.map((publisher) => publisher.publishBatch(50)));
    expect(counts[0]! + counts[1]!).toBe(Number(before[0]?.count));
    const remaining = await orm.em.fork().execute<{ count: string }[]>(`select count(*) as count from outbox_messages where published_at is null`);
    expect(Number(remaining[0]?.count)).toBe(0);
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: events, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
    expect(received.Messages?.length).toBeGreaterThan(0);
    expect(JSON.parse(received.Messages![0]!.Body!).eventId).toBeDefined();
  }, 30000);

  it('schedules an outbox retry after a publication failure', async () => {
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } });
    class FailingPublisher extends SqsClient {
      override async publish(): Promise<void> { throw new Error('SQS unavailable'); }
    }
    expect(await new OutboxPublisherService(orm.em.fork(), new FailingPublisher()).publishBatch()).toBe(0);
    const rows = await orm.em.fork().execute<{ attempts: number; due_later: boolean; published_at: Date | null }[]>(
      `select attempts, next_attempt_at > now() as due_later, published_at from outbox_messages where aggregate_id = ?`, [wallet.id],
    );
    expect(rows).toHaveLength(1); expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.due_later).toBe(true); expect(rows[0]?.published_at).toBeNull();
    await orm.em.fork().execute(`update outbox_messages set next_attempt_at = now() where aggregate_id = ?`, [wallet.id]);
    expect(await new OutboxPublisherService(orm.em.fork(), new SqsClient()).publishBatch()).toBe(1);
  }, 30000);

  it('keeps the ledger consistent across three independent processes', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const base = { providerId: randomUUID(), playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: 'BET', money: { amount: '80.00', currency: 'BRL' } };
    const workers = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, 'test/helpers/financial-worker.ts', JSON.stringify({ ...base, externalTransactionId: randomUUID(), idempotencyKey: randomUUID() })], { env: { ...process.env, TEST_SCHEMA: schema }, stdout: 'pipe', stderr: 'pipe' }));
    const outputs = await Promise.all(workers.map(async (worker) => ({ status: await worker.exited, stdout: await new Response(worker.stdout).text(), stderr: await new Response(worker.stderr).text() })));
    expect(outputs.map((item) => ({ status: item.status, stderr: item.stderr }))).toEqual(Array.from({ length: 3 }, () => ({ status: 0, stderr: '' })));
    const results = outputs.map((item) => JSON.parse(item.stdout) as { status: string });
    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'REJECTED')).toHaveLength(2);
    const rows = await orm.em.fork().execute<{ balance: string; ledger: string }[]>(`select w.balance, (select sum(case when direction = 'CREDIT' then amount else -amount end) from wallet_ledger_entries where wallet_id = w.id) as ledger from wallets w where id = ?`, [wallet.id]);
    expect(rows[0]?.balance).toBe('20.00'); expect(rows[0]?.ledger).toBe('20.00');
  }, 30000);


  it('recovers after a worker process exits between commit and ack', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const messageId = randomUUID();
    const body = JSON.stringify({ messageId, type: 'WagerTransactionRequested', data: { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: 'BET', money: { amount: '40.00', currency: 'BRL' } } });
    await sqs.send(new SendMessageCommand({ QueueUrl: mainQueue, MessageBody: body, MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID() }));
    const worker = Bun.spawn([process.execPath, 'test/helpers/sqs-crash-worker.ts'], { env: { ...process.env, TEST_SCHEMA: schema }, stdout: 'pipe', stderr: 'pipe' });
    expect(await worker.exited).toBe(23);
    await new WagerConsumerService(new SqsClient(), orm.em.fork(), new ProcessWagerTransactionService(orm.em.fork())).processAvailable();
    const rows = await orm.em.fork().execute<{ balance: string; ledger: string; debits: string }[]>(`select w.balance,
      (select sum(case when direction = 'CREDIT' then amount else -amount end) from wallet_ledger_entries where wallet_id = w.id) as ledger,
      (select count(*) from wallet_ledger_entries where wallet_id = w.id and direction = 'DEBIT') as debits from wallets w where id = ?`, [wallet.id]);
    expect(rows[0]?.balance).toBe('60.00'); expect(rows[0]?.ledger).toBe('60.00'); expect(Number(rows[0]?.debits)).toBe(1);
  }, 30000);

  it('redrives transient failures after the configured limit', async () => {
    const body = JSON.stringify({ messageId: randomUUID(), type: 'WagerTransactionRequested', data: {} });
    await sqs.send(new SendMessageCommand({ QueueUrl: mainQueue, MessageBody: body, MessageGroupId: randomUUID(), MessageDeduplicationId: randomUUID() }));
    class FailProcessing extends ProcessWagerTransactionService {
      override async execute(): Promise<never> { throw new Error('transient failure'); }
    }
    class ImmediateRetry extends SqsClient {
      override async changeVisibility(queue: string, handle: string): Promise<void> { await super.changeVisibility(queue, handle, 0); }
    }
    const consumer = new WagerConsumerService(new ImmediateRetry(), orm.em.fork(), new FailProcessing(orm.em.fork()));
    await consumer.processAvailable(); await consumer.processAvailable();
    await sqs.send(new ReceiveMessageCommand({ QueueUrl: mainQueue, WaitTimeSeconds: 1 }));
    const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlq, WaitTimeSeconds: 2 }));
    expect(result.Messages?.some((item) => item.Body === body)).toBe(true);
  }, 30000);


  it('rolls back wallet, opening transaction, ledger and outbox when opening fails', async () => {
    const em = orm.em.fork();
    const playerId = randomUUID();
    await em.execute(`create function fail_test_outbox() returns trigger language plpgsql as $$ begin raise exception 'test failure'; end; $$`);
    await em.execute(`create trigger fail_test_outbox before insert on outbox_messages for each row execute function fail_test_outbox()`);
    try {
      try { await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }); throw new Error('expected failure'); } catch (error) { expect(String(error)).toContain('test failure'); }
      const rows = await em.execute<{ wallets: string; transactions: string; ledger: string }[]>(`select
        (select count(*) from wallets where player_id = ?) as wallets,
        (select count(*) from wager_transactions where player_id = ?) as transactions,
        (select count(*) from wallet_ledger_entries l join wallets w on w.id = l.wallet_id where w.player_id = ?) as ledger`, [playerId, playerId, playerId]);
      expect(Number(rows[0]?.wallets)).toBe(0); expect(Number(rows[0]?.transactions)).toBe(0); expect(Number(rows[0]?.ledger)).toBe(0);
    } finally {
      await em.execute(`drop trigger fail_test_outbox on outbox_messages`);
      await em.execute(`drop function fail_test_outbox()`);
    }
  }, 30000);

  it('recovers the outbox after a publisher exits immediately after sending', async () => {
    const queue = (await sqs.send(new CreateQueueCommand({ QueueName: `crash-${randomUUID()}.fifo`, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'true' } }))).QueueUrl!;
    const previousQueue = process.env.EVENT_QUEUE_URL;
    process.env.EVENT_QUEUE_URL = queue;
    try {
      const em = orm.em.fork();
      await new OpenWalletService(em).execute({ playerId: randomUUID(), initialBalance: { amount: '10.00', currency: 'BRL' } });
      const pending = await em.execute<{ id: string }[]>(`select id from outbox_messages where published_at is null order by occurred_at, id`);
      const worker = Bun.spawn([process.execPath, 'test/helpers/outbox-crash-worker.ts'], { env: { ...process.env, TEST_SCHEMA: schema }, stdout: 'pipe', stderr: 'pipe' });
      expect(await worker.exited).toBe(24);
      const stillPending = await em.execute<{ count: string }[]>(`select count(*) as count from outbox_messages where published_at is null`);
      expect(Number(stillPending[0]?.count)).toBe(pending.length);
      const publisher = new OutboxPublisherService(orm.em.fork(), new SqsClient());
      expect(await publisher.publishBatch(50)).toBe(pending.length);
      const receivedIds = new Set<string>();
      for (let i = 0; i < pending.length + 5 && receivedIds.size < pending.length; i++) {
        const messages = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queue, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
        for (const message of messages.Messages ?? []) {
          receivedIds.add((JSON.parse(message.Body!) as { eventId: string }).eventId);
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: message.ReceiptHandle! }));
        }
      }
      expect([...receivedIds].sort()).toEqual(pending.map((entry) => entry.id).sort());
    } finally {
      if (previousQueue === undefined) delete process.env.EVENT_QUEUE_URL; else process.env.EVENT_QUEUE_URL = previousQueue;
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queue }));
    }
  }, 30000);


  it('returns clear HTTP responses for invalid input and a missing wallet', async () => {
    const module = await Test.createTestingModule({ controllers: [WalletsController, WageringController], providers: [
      { provide: EntityManager, useValue: orm.em.fork() }, OpenWalletService, WalletQueryService, ProcessWagerTransactionService, WagerQueryService,
    ] }).compile();
    const app = module.createNestApplication(); await app.init();
    try {
      await request(app.getHttpServer()).post('/wallets').send({ playerId: 'player', initialBalance: { amount: '-1.00', currency: 'BRL' } }).expect(400);
      await request(app.getHttpServer()).get('/wallets/unknown/ledger?limit=abc').expect(400);
      await request(app.getHttpServer()).post('/wagering/transactions').set('Idempotency-Key', randomUUID()).send({ providerId: randomUUID(), externalTransactionId: randomUUID(), playerId: randomUUID(), walletId: randomUUID(), roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } }).expect(404);
    } finally { await app.close(); }
  }, 30000);

  it('reports a negative ledger balance as a reconciliation divergence', async () => {
    const em = orm.em.fork();
    const wallet = await new OpenWalletService(em).execute({ playerId: randomUUID(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    const transactionId = randomUUID();
    await em.execute(`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'BET', 10, 'BRL', 'PROCESSED')`, [transactionId, randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), wallet.id, wallet.playerId, 'r', 'g']);
    await em.execute(`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after) values (?, ?, ?, 'DEBIT', 10, 'BRL', 100, 90)`, [randomUUID(), wallet.id, transactionId]);
    const result = await new WalletQueryService(em).reconcile(wallet.id);
    expect(result.consistent).toBe(false); expect(result.calculatedBalance.amount).toBe('-10.00'); expect(result.difference.amount).toBe('10.00');
  }, 30000);


  it('waits for a pending reference and applies dependent reversals in order', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const bet = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const refund = { ...bet, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), kind: WagerTransactionKind.Refund, referenceExternalTransactionId: bet.externalTransactionId, correlationId: 'correlation-test', causationId: 'message-test' };
    const rollback = { ...bet, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: refund.externalTransactionId };
    const service = new ProcessWagerTransactionService(orm.em.fork());
    const a = await service.execute(refund); const b = await service.execute(rollback);
    expect(a.status).toBe('PENDING_REFERENCE'); expect(b.status).toBe('PENDING_REFERENCE');
    await service.execute(bet);
    const em = orm.em.fork();
    const worker = new WagerWorkerService(em, null as never, null as never, service);
    for (const id of [a.transactionId, b.transactionId]) {
      await em.execute(`update wager_transactions set next_reference_attempt_at = now() - interval '1 second' where id = ?`, [id]);
      await (worker as unknown as { retryReference(): Promise<void> }).retryReference();
    }
    const rows = await em.execute<{ status: string; balance: string; ledger: string }[]>(`select t.status, w.balance, (select sum(case when direction = 'CREDIT' then amount else -amount end) from wallet_ledger_entries where wallet_id = w.id) as ledger from wager_transactions t join wallets w on w.id = t.wallet_id where t.id = ?`, [b.transactionId]);
    expect(rows[0]?.status).toBe('PROCESSED'); expect(rows[0]?.balance).toBe('90.00'); expect(rows[0]?.ledger).toBe('90.00');
    const events = await em.execute<{ payload: { correlationId: string; causationId: string } }[]>(`select payload from outbox_messages where aggregate_id = ?`, [a.transactionId]);
    expect(events.length).toBe(2); expect(events.every((event) => event.payload.correlationId === 'correlation-test' && event.payload.causationId === 'message-test')).toBe(true);
  }, 30000);

  it('skips a locked wallet when retrying a reference and processes it after release', async () => {
    const playerId = randomUUID();
    const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const bet = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const win = { ...bet, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), kind: WagerTransactionKind.Win, referenceExternalTransactionId: bet.externalTransactionId };
    const processor = new ProcessWagerTransactionService(orm.em.fork());
    const pending = await processor.execute(win);
    expect(pending.status).toBe('PENDING_REFERENCE');
    await processor.execute(bet);
    await orm.em.fork().execute(`update wager_transactions set next_reference_attempt_at = now() - interval '1 second' where id = ?`, [pending.transactionId]);
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = orm.em.fork().transactional(async (tx) => {
      await tx.execute(`select id from wallets where id = ? for no key update`, [wallet.id]);
      locked();
      await gate;
    });
    await ready;
    const worker = new WagerWorkerService(orm.em.fork(), null as never, null as never, processor);
    try {
      await (worker as unknown as { retryReference(): Promise<void> }).retryReference();
      const rows = await orm.em.fork().execute<{ status: string }[]>(`select status from wager_transactions where id = ?`, [pending.transactionId]);
      expect(rows[0]?.status).toBe('PENDING_REFERENCE');
    } finally {
      release();
      await holding;
    }
    await (worker as unknown as { retryReference(): Promise<void> }).retryReference();
    const result = await new WalletQueryService(orm.em.fork()).reconcile(wallet.id);
    expect(result.consistent).toBe(true); expect(result.storedBalance.amount).toBe('100.00');
    const rows = await orm.em.fork().execute<{ status: string }[]>(`select status from wager_transactions where id = ?`, [pending.transactionId]);
    expect(rows[0]?.status).toBe('PROCESSED');
  }, 30000);

  it('validates a WIN reference without requiring the prize to equal the bet', async () => {
    const playerId = randomUUID(); const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const bet = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const service = new ProcessWagerTransactionService(orm.em.fork()); await service.execute(bet);
    const win = { ...bet, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), kind: WagerTransactionKind.Win, money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId };
    expect((await service.execute(win)).balance?.amount).toBe('110.00');
    expect((await service.execute({ ...win, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), roundId: 'other' })).failureCode).toBe('INVALID_REFERENCE');
  }, 30000);


  it('supports legacy hash replay and rejects a different business payload', async () => {
    const playerId = randomUUID(); const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const input = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } };
    const service = new ProcessWagerTransactionService(orm.em.fork()); const initial = await service.execute(input);
    const legacy = JSON.stringify({ gameId: input.gameId, kind: input.kind, money: input.money, playerId: input.playerId, providerId: input.providerId, referenceExternalTransactionId: null, roundId: input.roundId, walletId: input.walletId, externalTransactionId: input.externalTransactionId });
    await orm.em.fork().execute(`update wager_transactions set payload_hash = ? where id = ?`, [createHash('sha256').update(legacy).digest('hex'), initial.transactionId]);
    expect((await service.execute(input)).idempotentReplay).toBe(true);
    try { await service.execute({ ...input, money: { amount: '11.00', currency: 'BRL' } }); throw new Error('expected conflict'); } catch (error) { expect((error as { status?: number }).status).toBe(409); }
    try { await service.execute({ ...input, providerId: randomUUID() }); throw new Error('expected conflict'); } catch (error) { expect((error as { status?: number }).status).toBe(409); }
  }, 30000);


  it('maps transient database outages to HTTP 503', async () => {
    const failing = { execute: () => Promise.reject(Object.assign(new Error('database unavailable'), { code: 'ECONNREFUSED' })) };
    const module = await Test.createTestingModule({ controllers: [WageringController], providers: [
      { provide: ProcessWagerTransactionService, useValue: failing }, { provide: WagerQueryService, useValue: {} },
    ] }).compile();
    const app = module.createNestApplication(); app.useGlobalFilters(new InfrastructureExceptionFilter()); await app.init();
    try { await request(app.getHttpServer()).post('/wagering/transactions').set('Idempotency-Key', 'key').send({}).expect(503); }
    finally { await app.close(); }
  }, 30000);

  it('keeps LOSS out of the ledger and rejects an unfunded rollback', async () => {
    const playerId = randomUUID(); const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
    const service = new ProcessWagerTransactionService(orm.em.fork());
    const base = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Loss, money: { amount: '1.00', currency: 'BRL' } };
    const loss = await service.execute(base); expect(loss.status).toBe('PROCESSED'); expect(loss.balance?.amount).toBe('10.00');
    const win = { ...base, kind: WagerTransactionKind.Win, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), money: { amount: '10.00', currency: 'BRL' } }; await service.execute(win);
    await service.execute({ ...base, kind: WagerTransactionKind.Bet, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), money: { amount: '20.00', currency: 'BRL' } });
    const rollback = await service.execute({ ...win, kind: WagerTransactionKind.Rollback, externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), referenceExternalTransactionId: win.externalTransactionId });
    expect(rollback.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    const rows = await orm.em.fork().execute<{ ledger: string; balance: string; loss_entries: string }[]>(`select w.balance, (select sum(case when direction = 'CREDIT' then amount else -amount end) from wallet_ledger_entries where wallet_id = w.id) as ledger, (select count(*) from wallet_ledger_entries where transaction_id = ?) as loss_entries from wallets w where id = ?`, [loss.transactionId, wallet.id]);
    expect(rows[0]?.balance).toBe('0.00'); expect(rows[0]?.ledger).toBe('0.00'); expect(Number(rows[0]?.loss_entries)).toBe(0);
  }, 30000);

  it('paginates ledger entries without losing PostgreSQL microseconds', async () => {
    const em = orm.em.fork(); const wallet = await new OpenWalletService(em).execute({ playerId: randomUUID(), initialBalance: { amount: '0.00', currency: 'BRL' } });
    for (const [index, stamp] of ['2026-01-01 00:00:00.123999+00', '2026-01-01 00:00:00.123500+00', '2026-01-01 00:00:00.123001+00'].entries()) {
      const transactionId = randomUUID(); await em.execute(`insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'WIN', 1, 'BRL', 'PROCESSED')`, [transactionId, randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), wallet.id, wallet.playerId, 'r', 'g']);
      await em.execute(`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at) values (?, ?, ?, 'CREDIT', 1, 'BRL', ?, ?, ?)`, [randomUUID(), wallet.id, transactionId, String(index), String(index + 1), stamp]);
    }
    const query = new WalletQueryService(em); let cursor: string | undefined; const ids: string[] = [];
    do { const page = await query.getLedger(wallet.id, cursor, 1); ids.push(...page.items.map((item) => item.id)); cursor = page.nextCursor; } while (cursor);
    expect(ids).toHaveLength(3); expect(new Set(ids).size).toBe(3);
  }, 30000);


  it('reverses and reapplies every migration in an isolated schema', async () => {
    const migrationSchema = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.em.fork().execute(`create schema "${migrationSchema}"`);
    let instance: MikroORM | undefined;
    try {
      instance = await MikroORM.init({ ...config, schema: migrationSchema, driverOptions: { options: `-c search_path=${migrationSchema}` }, migrations: { ...config.migrations, schema: migrationSchema } });
      const migrator = new Migrator(instance.em); await migrator.up();
      const applied = await migrator.getExecuted(); expect(applied.length).toBeGreaterThan(0);
      for (let i = 0; i < applied.length; i++) await migrator.down();
      expect(await migrator.getExecuted()).toHaveLength(0);
      await migrator.up(); expect((await migrator.getExecuted()).length).toBe(applied.length);
    } finally {
      await instance?.close(); await admin.em.fork().execute(`drop schema if exists "${migrationSchema}" cascade`);
    }
  }, 30000);

  it('processes separate wallets in parallel and rejects currency conflicts', async () => {
    const open = new OpenWalletService(orm.em.fork()); const playerA = randomUUID(); const playerB = randomUUID();
    const [walletA, walletB] = await Promise.all([open.execute({ playerId: playerA, initialBalance: { amount: '50.00', currency: 'BRL' } }), open.execute({ playerId: playerB, initialBalance: { amount: '50.00', currency: 'BRL' } })]);
    const input = (walletId: string, playerId: string) => ({ providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId, walletId, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Bet, money: { amount: '10.00', currency: 'BRL' } });
    const [a, b] = await Promise.all([new ProcessWagerTransactionService(orm.em.fork()).execute(input(walletA.id, playerA)), new ProcessWagerTransactionService(orm.em.fork()).execute(input(walletB.id, playerB))]);
    expect(a.balance?.amount).toBe('40.00'); expect(b.balance?.amount).toBe('40.00');
    const mismatch = { ...input(walletA.id, playerA), money: { amount: '10.00', currency: 'USD' } };
    expect((await new ProcessWagerTransactionService(orm.em.fork()).execute(mismatch)).failureCode).toBe('INVALID_PAYLOAD');
    const rows = await orm.em.fork().execute<{ balance: string; ledger: string }[]>(`select w.balance, (select sum(case when direction = 'CREDIT' then amount else -amount end) from wallet_ledger_entries where wallet_id = w.id) as ledger from wallets w where id in (?, ?)`, [walletA.id, walletB.id]);
    expect(rows).toHaveLength(2); expect(rows.every((row) => row.balance === row.ledger && row.balance === '40.00')).toBe(true);
  }, 30000);


  it('rejects an unresolved reference at the retry limit and emits an event', async () => {
    const playerId = randomUUID(); const wallet = await new OpenWalletService(orm.em.fork()).execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
    const input = { providerId: randomUUID(), externalTransactionId: randomUUID(), idempotencyKey: randomUUID(), playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game', kind: WagerTransactionKind.Refund, money: { amount: '1.00', currency: 'BRL' }, referenceExternalTransactionId: randomUUID() };
    const service = new ProcessWagerTransactionService(orm.em.fork()); const pending = await service.execute(input); const em = orm.em.fork();
    await em.execute(`update wager_transactions set reference_attempts = 8, next_reference_attempt_at = now() - interval '1 second' where id = ?`, [pending.transactionId]);
    const worker = new WagerWorkerService(em, null as never, null as never, service);
    await (worker as unknown as { retryReference(): Promise<void> }).retryReference();
    const rows = await em.execute<{ status: string; failure_code: string; events: string }[]>(`select t.status, t.failure_code, (select count(*) from outbox_messages where aggregate_id = t.id and event_type = 'WagerTransactionRejected') as events from wager_transactions t where id = ?`, [pending.transactionId]);
    expect(rows[0]?.status).toBe('REJECTED'); expect(rows[0]?.failure_code).toBe('REFERENCE_NOT_FOUND'); expect(Number(rows[0]?.events)).toBe(1);
    const reconciliation = await new WalletQueryService(em).reconcile(wallet.id); expect(reconciliation.consistent).toBe(true);
  }, 30000);

  it('exposes transaction, queue and retry metrics', async () => {
    const metrics = new MetricsService(); metrics.increment('retries');
    const result = await new MetricsController(orm.em.fork(), metrics, new SqsClient()).getMetrics();
    expect(result.process.retries).toBe(1); expect(result.transactionsByStatus.PROCESSED).toBeGreaterThan(0);
    expect(result.dlqDepth).not.toBeNull(); expect(result.outboxLagSeconds).toBeGreaterThanOrEqual(0);
  }, 30000);

});
