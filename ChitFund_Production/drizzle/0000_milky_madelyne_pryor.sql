CREATE TABLE "otp_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mobile_number" varchar(15) NOT NULL,
	"otp_hash" varchar(255) NOT NULL,
	"purpose" varchar(20) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh_key" text NOT NULL,
	"auth_key" text NOT NULL,
	"device_info" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "push_subscriptions_user_id_endpoint_unique" UNIQUE("user_id","endpoint")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(255) NOT NULL,
	"session_id" uuid,
	"device_info" varchar(255),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"mobile_number" varchar(15) NOT NULL,
	"username" varchar(50),
	"password_hash" varchar(255) NOT NULL,
	"mobile_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_mobile_number_unique" UNIQUE("mobile_number"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "chit_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"invitation_code" varchar(10) NOT NULL,
	"pool_amount" bigint NOT NULL,
	"monthly_contribution" bigint NOT NULL,
	"total_months" smallint NOT NULL,
	"total_shares" smallint NOT NULL,
	"start_month" date NOT NULL,
	"payment_due_day" smallint DEFAULT 10 NOT NULL,
	"admin_commission_rate" numeric(4, 2) DEFAULT '0.00' NOT NULL,
	"monthly_interest_rate" numeric(4, 2) DEFAULT '5.00' NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"status" varchar(20) DEFAULT 'Active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"invitation_code_expires_at" timestamp with time zone,
	CONSTRAINT "chit_groups_invitation_code_unique" UNIQUE("invitation_code"),
	CONSTRAINT "chk_pool_matches" CHECK ("chit_groups"."pool_amount" = "chit_groups"."monthly_contribution" * "chit_groups"."total_shares"),
	CONSTRAINT "chk_months_shares" CHECK ("chit_groups"."total_months" > 0 AND "chit_groups"."total_shares" > 0 AND "chit_groups"."total_months" = "chit_groups"."total_shares"),
	CONSTRAINT "chk_commission_rate" CHECK ("chit_groups"."admin_commission_rate" >= 0 AND "chit_groups"."admin_commission_rate" <= 100),
	CONSTRAINT "chk_interest_rate" CHECK ("chit_groups"."monthly_interest_rate" >= 0 AND "chit_groups"."monthly_interest_rate" <= 100),
	CONSTRAINT "chk_payment_due_day" CHECK ("chit_groups"."payment_due_day" >= 1 AND "chit_groups"."payment_due_day" <= 28)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(20) NOT NULL,
	"share_count" smallint DEFAULT 1 NOT NULL,
	"requested_share_count" smallint,
	"wins_count" smallint DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'Active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	"notes" text,
	CONSTRAINT "uniq_group_user" UNIQUE("group_id","user_id"),
	CONSTRAINT "chk_role" CHECK ("memberships"."role" IN ('Admin', 'Member')),
	CONSTRAINT "chk_membership_status" CHECK ("memberships"."status" IN ('Pending', 'Active', 'Inactive')),
	CONSTRAINT "chk_requested_share_count" CHECK ("memberships"."requested_share_count" IS NULL OR "memberships"."requested_share_count" >= 1),
	CONSTRAINT "chk_share_count" CHECK ("memberships"."share_count" >= 1),
	CONSTRAINT "chk_wins_le_shares" CHECK ("memberships"."wins_count" >= 0 AND "memberships"."wins_count" <= "memberships"."share_count")
);
--> statement-breakpoint
CREATE TABLE "monthly_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"month_number" smallint NOT NULL,
	"month_label" varchar(20) NOT NULL,
	"due_date" date NOT NULL,
	"is_skip_month" boolean DEFAULT false NOT NULL,
	"winner_user_id" uuid,
	"bid_amount" bigint,
	"admin_commission" bigint,
	"basket_credit" bigint,
	"winner_takeaway" bigint,
	"status" varchar(20) DEFAULT 'Open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"notes" text,
	CONSTRAINT "uniq_group_month" UNIQUE("group_id","month_number"),
	CONSTRAINT "chk_cycle_status" CHECK ("monthly_cycles"."status" IN ('Open', 'Closed')),
	CONSTRAINT "chk_bid_consistency" CHECK (
    ("monthly_cycles"."winner_user_id" IS NULL AND "monthly_cycles"."bid_amount" IS NULL AND "monthly_cycles"."admin_commission" IS NULL AND "monthly_cycles"."basket_credit" IS NULL AND "monthly_cycles"."winner_takeaway" IS NULL)
    OR
    ("monthly_cycles"."winner_user_id" IS NOT NULL AND "monthly_cycles"."bid_amount" IS NOT NULL AND "monthly_cycles"."admin_commission" IS NOT NULL AND "monthly_cycles"."basket_credit" IS NOT NULL AND "monthly_cycles"."winner_takeaway" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "loan_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"txn_type" varchar(20) NOT NULL,
	"amount" bigint NOT NULL,
	"txn_date" date NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_loan_txn_type" CHECK ("loan_transactions"."txn_type" IN ('PRINCIPAL_REPAID', 'INTEREST_PAID')),
	CONSTRAINT "chk_loan_txn_amount" CHECK ("loan_transactions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"basket_id" uuid NOT NULL,
	"borrower_user_id" uuid NOT NULL,
	"principal" bigint NOT NULL,
	"monthly_interest_rate" numeric(4, 2) NOT NULL,
	"disbursement_month_number" smallint DEFAULT 1 NOT NULL,
	"total_interest_paid" bigint DEFAULT 0 NOT NULL,
	"disbursed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expected_close_date" date,
	"closed_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'Active' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_loan_status" CHECK ("loans"."status" IN ('Active', 'Repaid', 'WrittenOff')),
	CONSTRAINT "chk_principal_positive" CHECK ("loans"."principal" > 0),
	CONSTRAINT "chk_loan_interest_rate" CHECK ("loans"."monthly_interest_rate" >= 0 AND "loans"."monthly_interest_rate" <= 100)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" varchar(20) NOT NULL,
	"changed_by" uuid NOT NULL,
	"old_values" jsonb,
	"new_values" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cycle_id" uuid NOT NULL,
	"member_user_id" uuid NOT NULL,
	"expected_amount" bigint NOT NULL,
	"paid_amount" bigint DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'Unpaid' NOT NULL,
	"paid_at" timestamp with time zone,
	"marked_by" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_cycle_member" UNIQUE("cycle_id","member_user_id"),
	CONSTRAINT "chk_payment_status" CHECK ("payments"."status" IN ('Paid', 'Unpaid', 'Waived')),
	CONSTRAINT "chk_paid_consistency" CHECK (
    ("payments"."status" = 'Paid' AND "payments"."paid_at" IS NOT NULL AND "payments"."marked_by" IS NOT NULL)
    OR
    ("payments"."status" IN ('Unpaid', 'Waived'))
  )
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid,
	"muted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_pref_user_group" UNIQUE("user_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid,
	"type" varchar(40) NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"read_at" timestamp with time zone,
	"sent_via_push" boolean DEFAULT false NOT NULL,
	"sent_via_sms" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mobile_number" varchar(15) NOT NULL,
	"purpose" varchar(30) NOT NULL,
	"provider" varchar(20) NOT NULL,
	"provider_msg_id" varchar(100),
	"status" varchar(20) DEFAULT 'Sent' NOT NULL,
	"error_message" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "chk_sms_status" CHECK ("sms_logs"."status" IN ('Sent', 'Delivered', 'Failed'))
);
--> statement-breakpoint
CREATE TABLE "basket_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"basket_id" uuid NOT NULL,
	"cycle_id" uuid,
	"txn_type" varchar(30) NOT NULL,
	"amount" bigint NOT NULL,
	"direction" char(1) NOT NULL,
	"counterparty_user_id" uuid,
	"related_loan_id" uuid,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_txn_type" CHECK ("basket_transactions"."txn_type" IN (
    'CREDIT_DISCOUNT',
    'DEBIT_SKIP_MONTH',
    'LOAN_DISBURSED',
    'LOAN_REPAID',
    'INTEREST_ACCRUED',
    'CLOSURE_SPLIT',
    'ADJUSTMENT'
  )),
	CONSTRAINT "chk_direction" CHECK ("basket_transactions"."direction" IN ('C', 'D')),
	CONSTRAINT "chk_amount_positive" CHECK ("basket_transactions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "baskets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"current_balance" bigint DEFAULT 0 NOT NULL,
	"total_credited" bigint DEFAULT 0 NOT NULL,
	"total_debited" bigint DEFAULT 0 NOT NULL,
	"total_lent_out" bigint DEFAULT 0 NOT NULL,
	"total_interest_earned" bigint DEFAULT 0 NOT NULL,
	"last_recomputed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "baskets_group_id_unique" UNIQUE("group_id")
);
--> statement-breakpoint
CREATE TABLE "pending_admin_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"to_membership_id" uuid NOT NULL,
	"from_confirmed_at" timestamp with time zone,
	"to_confirmed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"actor_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chit_groups" ADD CONSTRAINT "chit_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_group_id_chit_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chit_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_cycles" ADD CONSTRAINT "monthly_cycles_group_id_chit_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chit_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monthly_cycles" ADD CONSTRAINT "monthly_cycles_winner_user_id_users_id_fk" FOREIGN KEY ("winner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_transactions" ADD CONSTRAINT "loan_transactions_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_transactions" ADD CONSTRAINT "loan_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_basket_id_baskets_id_fk" FOREIGN KEY ("basket_id") REFERENCES "public"."baskets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_borrower_user_id_users_id_fk" FOREIGN KEY ("borrower_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_cycle_id_monthly_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."monthly_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_group_id_chit_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chit_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_group_id_chit_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chit_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basket_transactions" ADD CONSTRAINT "basket_transactions_basket_id_baskets_id_fk" FOREIGN KEY ("basket_id") REFERENCES "public"."baskets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basket_transactions" ADD CONSTRAINT "basket_transactions_cycle_id_monthly_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."monthly_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basket_transactions" ADD CONSTRAINT "basket_transactions_counterparty_user_id_users_id_fk" FOREIGN KEY ("counterparty_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basket_transactions" ADD CONSTRAINT "basket_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baskets" ADD CONSTRAINT "baskets_group_id_chit_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chit_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_admin_transfers" ADD CONSTRAINT "pending_admin_transfers_group_id_chit_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chit_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_admin_transfers" ADD CONSTRAINT "pending_admin_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_admin_transfers" ADD CONSTRAINT "pending_admin_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_admin_transfers" ADD CONSTRAINT "pending_admin_transfers_to_membership_id_memberships_id_fk" FOREIGN KEY ("to_membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_activity" ADD CONSTRAINT "group_activity_group_id_chit_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."chit_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_activity" ADD CONSTRAINT "group_activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_push_user" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_user" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_users_mobile" ON "users" USING btree ("mobile_number");--> statement-breakpoint
CREATE INDEX "idx_users_username" ON "users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "idx_groups_creator" ON "chit_groups" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_groups_status" ON "chit_groups" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_one_admin_per_group" ON "memberships" USING btree ("group_id") WHERE "memberships"."role" = 'Admin' AND "memberships"."status" = 'Active';--> statement-breakpoint
CREATE INDEX "idx_memberships_user" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_memberships_group" ON "memberships" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_cycles_group" ON "monthly_cycles" USING btree ("group_id","month_number");--> statement-breakpoint
CREATE INDEX "idx_cycles_status" ON "monthly_cycles" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "idx_loan_txns_loan" ON "loan_transactions" USING btree ("loan_id","txn_date");--> statement-breakpoint
CREATE INDEX "idx_loans_borrower" ON "loans" USING btree ("borrower_user_id");--> statement-breakpoint
CREATE INDEX "idx_loans_basket" ON "loans" USING btree ("basket_id");--> statement-breakpoint
CREATE INDEX "idx_loans_status" ON "loans" USING btree ("basket_id","status");--> statement-breakpoint
CREATE INDEX "idx_audit_entity" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_user" ON "audit_logs" USING btree ("changed_by","created_at");--> statement-breakpoint
CREATE INDEX "idx_payments_cycle" ON "payments" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "idx_payments_member" ON "payments" USING btree ("member_user_id");--> statement-breakpoint
CREATE INDEX "idx_payments_status" ON "payments" USING btree ("cycle_id","status");--> statement-breakpoint
CREATE INDEX "idx_notif_user_unread" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notif_user_all" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_sms_mobile" ON "sms_logs" USING btree ("mobile_number","sent_at");--> statement-breakpoint
CREATE INDEX "idx_sms_status" ON "sms_logs" USING btree ("status","sent_at");--> statement-breakpoint
CREATE INDEX "idx_txns_basket" ON "basket_transactions" USING btree ("basket_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_txns_cycle" ON "basket_transactions" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "idx_txns_loan" ON "basket_transactions" USING btree ("related_loan_id");--> statement-breakpoint
CREATE INDEX "idx_txns_user" ON "basket_transactions" USING btree ("counterparty_user_id");--> statement-breakpoint
CREATE INDEX "idx_transfers_group" ON "pending_admin_transfers" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_transfers_from" ON "pending_admin_transfers" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "idx_transfers_to" ON "pending_admin_transfers" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "idx_activity_group" ON "group_activity" USING btree ("group_id","created_at");