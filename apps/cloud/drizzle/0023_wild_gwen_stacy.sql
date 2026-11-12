ALTER TABLE "oauth_client" ADD COLUMN "origin_requested_scopes" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "origin_scopes" text;