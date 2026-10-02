CREATE TABLE "page_invitations" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "page_invitations_hash_check" CHECK ("page_invitations"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "page_invitations" ADD CONSTRAINT "page_invitations_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
UPDATE "schema_versions" SET "version" = 3 WHERE "version" = 2;
