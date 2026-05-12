ALTER TABLE "monthly_cycles" DROP CONSTRAINT "chk_bid_consistency";--> statement-breakpoint
ALTER TABLE "chit_groups" ADD COLUMN "admin_commission_rate" numeric(4, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "monthly_cycles" ADD COLUMN "admin_commission" bigint;--> statement-breakpoint
ALTER TABLE "monthly_cycles" ADD COLUMN "basket_credit" bigint;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "total_interest_accrued" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chit_groups" ADD CONSTRAINT "chk_commission_rate" CHECK ("chit_groups"."admin_commission_rate" >= 0 AND "chit_groups"."admin_commission_rate" <= 100);--> statement-breakpoint
ALTER TABLE "monthly_cycles" ADD CONSTRAINT "chk_bid_consistency" CHECK (
    ("monthly_cycles"."winner_user_id" IS NULL AND "monthly_cycles"."bid_amount" IS NULL AND "monthly_cycles"."admin_commission" IS NULL AND "monthly_cycles"."basket_credit" IS NULL AND "monthly_cycles"."winner_takeaway" IS NULL)
    OR
    ("monthly_cycles"."winner_user_id" IS NOT NULL AND "monthly_cycles"."bid_amount" IS NOT NULL AND "monthly_cycles"."admin_commission" IS NOT NULL AND "monthly_cycles"."basket_credit" IS NOT NULL AND "monthly_cycles"."winner_takeaway" IS NOT NULL)
  );