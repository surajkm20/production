CREATE TABLE "cycle_winners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"winner_number" smallint NOT NULL,
	"winner_user_id" uuid NOT NULL,
	"bid_amount" bigint NOT NULL,
	"admin_commission" bigint NOT NULL,
	"basket_credit" bigint NOT NULL,
	"winner_takeaway" bigint NOT NULL,
	"is_admin_withdrawal" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_cycle_slot" UNIQUE("cycle_id","winner_number"),
	CONSTRAINT "uniq_cycle_user" UNIQUE("cycle_id","winner_user_id")
);
--> statement-breakpoint
ALTER TABLE "monthly_cycles" DROP CONSTRAINT "chk_bid_consistency";--> statement-breakpoint
ALTER TABLE "monthly_cycles" DROP CONSTRAINT "monthly_cycles_winner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "cycle_winners" ADD CONSTRAINT "cycle_winners_cycle_id_monthly_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."monthly_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_winners" ADD CONSTRAINT "cycle_winners_group_id_chit_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chit_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_winners" ADD CONSTRAINT "cycle_winners_winner_user_id_users_id_fk" FOREIGN KEY ("winner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_winners" ADD CONSTRAINT "cycle_winners_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cycle_winners_cycle" ON "cycle_winners" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "idx_cycle_winners_group" ON "cycle_winners" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_cycle_winners_user" ON "cycle_winners" USING btree ("winner_user_id");--> statement-breakpoint
ALTER TABLE "monthly_cycles" DROP COLUMN "winner_user_id";--> statement-breakpoint
ALTER TABLE "monthly_cycles" DROP COLUMN "bid_amount";--> statement-breakpoint
ALTER TABLE "monthly_cycles" DROP COLUMN "admin_commission";--> statement-breakpoint
ALTER TABLE "monthly_cycles" DROP COLUMN "basket_credit";--> statement-breakpoint
ALTER TABLE "monthly_cycles" DROP COLUMN "winner_takeaway";