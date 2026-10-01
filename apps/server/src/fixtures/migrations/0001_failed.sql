CREATE TABLE migration_probe (id integer PRIMARY KEY);
--> statement-breakpoint
SELECT missing_column FROM migration_probe;
