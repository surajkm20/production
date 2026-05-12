ALTER TABLE "loan_transactions" DROP CONSTRAINT "chk_loan_txn_type";--> statement-breakpoint
ALTER TABLE "loans" DROP COLUMN "total_interest_accrued";--> statement-breakpoint
ALTER TABLE "loan_transactions" ADD CONSTRAINT "chk_loan_txn_type" CHECK ("loan_transactions"."txn_type" IN ('PRINCIPAL_REPAID', 'INTEREST_PAID'));