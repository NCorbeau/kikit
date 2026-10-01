-- The baseline also adopts databases created by the original local milestone.
-- Existing tables and binary document identities are left intact.
CREATE TABLE IF NOT EXISTS "schema_versions" (
  "version" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pages" (
  "id" uuid PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL,
  "schema_version" integer NOT NULL,
  "sequence" bigint DEFAULT 0 NOT NULL,
  "initial_state" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_grants" (
  "page_id" uuid NOT NULL,
  "account_id" text NOT NULL,
  "role" text NOT NULL,
  CONSTRAINT "page_grants_pkey" PRIMARY KEY("page_id", "account_id"),
  CONSTRAINT "page_grants_role_check" CHECK ("role" IN ('owner', 'editor')),
  CONSTRAINT "page_grants_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_updates" (
  "page_id" uuid NOT NULL,
  "sequence" bigint NOT NULL,
  "payload" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_updates_pkey" PRIMARY KEY("page_id", "sequence"),
  CONSTRAINT "document_updates_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "receipts" (
  "page_id" uuid NOT NULL,
  "batch_id" uuid NOT NULL,
  "payload_hash" text NOT NULL,
  "sequence" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "receipts_pkey" PRIMARY KEY("page_id", "batch_id"),
  CONSTRAINT "receipts_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id"),
  CONSTRAINT "receipts_page_id_sequence_fkey" FOREIGN KEY ("page_id", "sequence") REFERENCES "document_updates"("page_id", "sequence")
);
--> statement-breakpoint
INSERT INTO "schema_versions" ("version") VALUES (1) ON CONFLICT DO NOTHING;
