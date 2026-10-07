ALTER TABLE "pages" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "schema_versions" SET "version" = 5 WHERE "version" = 4;
