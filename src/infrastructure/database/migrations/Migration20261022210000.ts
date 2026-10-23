import { Migration } from '@mikro-orm/migrations';

export class Migration20261022210000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions add column reference_attempts integer not null default 0, add column next_reference_attempt_at timestamptz`);
    this.addSql(`update wager_transactions set next_reference_attempt_at = now() where status = 'PENDING_REFERENCE'`);
    this.addSql(`create index wager_reference_retry_due on wager_transactions (next_reference_attempt_at) where status = 'PENDING_REFERENCE'`);
  }
  override async down(): Promise<void> {
    this.addSql(`drop index wager_reference_retry_due`);
    this.addSql(`alter table wager_transactions drop column reference_attempts, drop column next_reference_attempt_at`);
  }
}
