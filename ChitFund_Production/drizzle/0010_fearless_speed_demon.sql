ALTER TABLE "users" ADD COLUMN "role" varchar(20) DEFAULT 'User' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_users_superadmin" ON "users" USING btree ("role") WHERE "users"."role" = 'SuperAdmin' AND "users"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "chk_user_role" CHECK ("users"."role" IN ('User', 'SuperAdmin'));