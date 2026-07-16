ALTER TABLE "chit_groups" DROP CONSTRAINT "chk_pool_matches";--> statement-breakpoint
ALTER TABLE "chit_groups" DROP CONSTRAINT "chk_months_shares";--> statement-breakpoint
ALTER TABLE "chit_groups" ADD CONSTRAINT "chk_pool_matches" CHECK ("chit_groups"."pool_amount" = "chit_groups"."monthly_contribution" * "chit_groups"."total_months");--> statement-breakpoint
ALTER TABLE "chit_groups" ADD CONSTRAINT "chk_months_shares" CHECK ("chit_groups"."total_months" > 0 AND "chit_groups"."total_shares" > 0 AND "chit_groups"."total_shares" >= "chit_groups"."total_months");