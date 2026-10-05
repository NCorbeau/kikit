-- Schema 2 accepts the existing paragraph/heading binary representation as-is.
-- Retain every Yjs byte, sequence, update and receipt; only compatibility metadata advances.
UPDATE "pages" SET "schema_version" = 2 WHERE "schema_version" = 1;
--> statement-breakpoint
UPDATE "schema_versions" SET "version" = 4 WHERE "version" = 3;
