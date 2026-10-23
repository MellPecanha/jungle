import { Migration } from '@mikro-orm/migrations';

export class Migration20261021220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "wallets" (
        "id" text not null,
        "player_id" text not null,
        "currency" varchar(3) not null,
        "balance" numeric(20,2) not null default 0,
        "version" integer not null default 1,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "wallets_pkey" primary key ("id"),
        constraint "wallets_balance_non_negative" check ("balance" >= 0),
        constraint "wallets_version_positive" check ("version" > 0),
        constraint "wallets_player_currency_unique" unique ("player_id", "currency")
      );
    `);

    this.addSql(`
      create table "wager_transactions" (
        "id" text not null,
        "provider_id" text not null,
        "external_transaction_id" text not null,
        "idempotency_key" text not null,
        "payload_hash" varchar(64) not null,
        "wallet_id" text not null,
        "player_id" text not null,
        "round_id" text not null,
        "game_id" text not null,
        "kind" varchar(20) not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "reference_external_transaction_id" text null,
        "reference_transaction_id" text null,
        "status" varchar(24) not null default 'PENDING',
        "failure_code" text null,
        "created_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        constraint "wager_transactions_pkey" primary key ("id"),
        constraint "wager_transactions_wallet_fk"
          foreign key ("wallet_id") references "wallets" ("id"),
        constraint "wager_transactions_reference_fk"
          foreign key ("reference_transaction_id") references "wager_transactions" ("id"),
        constraint "wager_transactions_amount_positive" check ("amount" > 0),
        constraint "wager_transactions_kind_check"
          check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint "wager_transactions_status_check"
          check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint "wager_transactions_provider_external_unique"
          unique ("provider_id", "external_transaction_id"),
        constraint "wager_transactions_provider_idempotency_unique"
          unique ("provider_id", "idempotency_key")
      );
    `);

    this.addSql(`
      create index "wager_transactions_pending_reference_idx"
        on "wager_transactions" ("reference_external_transaction_id")
        where "status" = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table "wallet_ledger_entries" (
        "id" text not null,
        "wallet_id" text not null,
        "transaction_id" text not null,
        "direction" varchar(6) not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "balance_before" numeric(20,2) not null,
        "balance_after" numeric(20,2) not null,
        "created_at" timestamptz not null default now(),
        constraint "wallet_ledger_entries_pkey" primary key ("id"),
        constraint "wallet_ledger_entries_wallet_fk"
          foreign key ("wallet_id") references "wallets" ("id"),
        constraint "wallet_ledger_entries_transaction_fk"
          foreign key ("transaction_id") references "wager_transactions" ("id"),
        constraint "wallet_ledger_entries_transaction_unique" unique ("transaction_id"),
        constraint "wallet_ledger_entries_direction_check"
          check ("direction" in ('DEBIT', 'CREDIT')),
        constraint "wallet_ledger_entries_amount_positive" check ("amount" > 0),
        constraint "wallet_ledger_entries_balances_non_negative"
          check ("balance_before" >= 0 and "balance_after" >= 0),
        constraint "wallet_ledger_entries_arithmetic_check"
          check (
            ("direction" = 'CREDIT' and "balance_after" = "balance_before" + "amount")
            or
            ("direction" = 'DEBIT' and "balance_after" = "balance_before" - "amount")
          )
      );
    `);

    this.addSql(`
      create index "wallet_ledger_entries_wallet_created_idx"
        on "wallet_ledger_entries" ("wallet_id", "created_at", "id");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "wallet_ledger_entries" cascade;');
    this.addSql('drop table if exists "wager_transactions" cascade;');
    this.addSql('drop table if exists "wallets" cascade;');
  }
}
