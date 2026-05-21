ALTER TABLE "basket_transactions" DROP CONSTRAINT "chk_txn_type";--> statement-breakpoint
ALTER TABLE "basket_transactions" ADD CONSTRAINT "chk_txn_type" CHECK ("basket_transactions"."txn_type" IN (
    'CREDIT_DISCOUNT',
    'DEBIT_SKIP_MONTH',
    'DEBIT_X_CHITI',
    'LOAN_DISBURSED',
    'LOAN_REPAID',
    'INTEREST_ACCRUED',
    'CLOSURE_SPLIT',
    'ADJUSTMENT'
  ));