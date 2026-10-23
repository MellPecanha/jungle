import { Migration } from '@mikro-orm/migrations';

export class Migration20261022190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "inbox_messages" (
        "message_id" text not null,
        "consumer_name" text not null,
        "payload_hash" varchar(64) not null,
        "received_at" timestamptz not null default now(),
        "processed_at" timestamptz null,
        constraint "inbox_messages_pkey" primary key ("consumer_name", "message_id")
      );
    `);

    this.addSql(`
      create table "outbox_messages" (
        "id" text not null,
        "aggregate_id" text not null,
        "event_type" text not null,
        "payload" jsonb not null,
        "occurred_at" timestamptz not null,
        "attempts" integer not null default 0,
        "next_attempt_at" timestamptz not null default now(),
        "published_at" timestamptz null,
        constraint "outbox_messages_pkey" primary key ("id"),
        constraint "outbox_messages_attempts_non_negative" check ("attempts" >= 0)
      );
    `);

    this.addSql(`
      create index "outbox_messages_pending_idx"
        on "outbox_messages" ("next_attempt_at", "occurred_at")
        where "published_at" is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "outbox_messages";');
    this.addSql('drop table if exists "inbox_messages";');
  }
}
