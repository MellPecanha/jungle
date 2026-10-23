import { Migration } from '@mikro-orm/migrations';

export class Migration20261022220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions add column correlation_id text, add column causation_id text`);
  }
  override async down(): Promise<void> {
    this.addSql(`alter table wager_transactions drop column correlation_id, drop column causation_id`);
  }
}
