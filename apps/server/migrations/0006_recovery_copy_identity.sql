ALTER TABLE "pages" ADD COLUMN "creation_input_hash" text;
--> statement-breakpoint
UPDATE "schema_versions" SET "version" = 7 WHERE "version" = 6;
