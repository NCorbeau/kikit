ALTER TABLE "receipts" DROP CONSTRAINT "receipts_page_id_sequence_fkey";
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "snapshot_state" "bytea";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "snapshot_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "repair_payload" "bytea";
--> statement-breakpoint
-- Preserve original server repairs independently of the removable update tail.
-- PostgreSQL's built-in SHA-256 needs no additional extension or runtime grant.
UPDATE "receipts" AS r SET "repair_payload" = u."payload"
FROM "document_updates" AS u
WHERE r."page_id" = u."page_id" AND r."sequence" = u."sequence"
  AND r."payload_hash" <> encode(sha256(u."payload"), 'hex');
--> statement-breakpoint
UPDATE "schema_versions" SET "version" = 6 WHERE "version" = 5;
