import { Migration } from '@mikro-orm/migrations';

export class Migration20261022230000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create unique index wager_transactions_idempotency_key_unique on wager_transactions (idempotency_key)`);
  }
  override async down(): Promise<void> {
    this.addSql(`drop index wager_transactions_idempotency_key_unique`);
  }
}
