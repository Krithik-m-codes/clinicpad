-- Plan 2A roles (generated, hand-edited): the designer role (templates only) and expiring memberships. memberships
-- has rows, so its CHECKs are added NOT VALID and validated here. The new enum value is not used as an enum literal in
-- this run (drizzle applies every pending migration in one transaction); the CHECK compares role::text.
ALTER TYPE "public"."member_role" ADD VALUE 'designer';--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_designer_expiry_check" CHECK (role::text <> 'designer' or expires_at is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "memberships" VALIDATE CONSTRAINT "memberships_designer_expiry_check";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_expiry_check" CHECK (expires_at is null or expires_at > created_at) NOT VALID;--> statement-breakpoint
ALTER TABLE "memberships" VALIDATE CONSTRAINT "memberships_expiry_check";
