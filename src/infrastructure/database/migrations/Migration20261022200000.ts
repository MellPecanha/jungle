import { Migration } from '@mikro-orm/migrations';

export class Migration20261022200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions add column result_balance numeric(20,2)`);
    this.addSql(`create unique index wager_transactions_unique_reversal on wager_transactions (kind, reference_transaction_id) where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')`);
    this.addSql(`create function prevent_ledger_mutation() returns trigger language plpgsql as $$ begin raise exception 'ledger entries are immutable'; end; $$`);
    this.addSql(`create trigger wallet_ledger_immutable before update or delete on wallet_ledger_entries for each row execute function prevent_ledger_mutation()`);
  }
  override async down(): Promise<void> {
    this.addSql(`drop trigger wallet_ledger_immutable on wallet_ledger_entries`);
    this.addSql(`drop function prevent_ledger_mutation()`);
    this.addSql(`drop index wager_transactions_unique_reversal`);
    this.addSql(`alter table wager_transactions drop column result_balance`);
  }
}
