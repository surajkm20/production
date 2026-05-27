CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(64) NOT NULL,
	"endpoint" varchar(100) NOT NULL,
	"user_id" uuid NOT NULL,
	"response_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_idempotency_key_endpoint" ON "idempotency_keys" USING btree ("key","endpoint");--> statement-breakpoint
CREATE INDEX "idx_idempotency_user" ON "idempotency_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_idempotency_expires" ON "idempotency_keys" USING btree ("expires_at");