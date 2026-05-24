ALTER TABLE "memberships" DROP CONSTRAINT "chk_share_count";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "chk_share_count" CHECK ("memberships"."share_count" >= 0);