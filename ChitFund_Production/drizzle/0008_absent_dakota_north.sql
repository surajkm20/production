ALTER TABLE "basket_transactions" DROP CONSTRAINT "chk_txn_type";--> statement-breakpoint
UPDATE "basket_transactions" SET "txn_type" = 'DEBIT_DOUBLE_CHITI' WHERE "txn_type" = 'DEBIT_X_CHITI';--> statement-breakpoint
ALTER TABLE "basket_transactions" ADD CONSTRAINT "chk_txn_type" CHECK ("basket_transactions"."txn_type" IN (
    'CREDIT_DISCOUNT',
    'DEBIT_SKIP_MONTH',
    'DEBIT_DOUBLE_CHITI',
    'DEBIT_FINAL_CYCLE_OFFSET',
    'LOAN_DISBURSED',
    'LOAN_REPAID',
    'INTEREST_ACCRUED',
    'CLOSURE_SPLIT',
    'ADJUSTMENT'
  ));