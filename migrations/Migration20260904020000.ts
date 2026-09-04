import { Migration } from "@mikro-orm/migrations";

/**
 * PROCESSED REFUND/ROLLBACK must resolve reference_transaction_id (ADR-023).
 * Partial unique indexes treat NULL as distinct — without this CHECK, two
 * PROCESSED reversals with NULL ref would both pass uq_reversal_ref_unique.
 */
export class Migration20260904020000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
ALTER TABLE wager_transactions
  ADD CONSTRAINT chk_processed_reversal_has_ref CHECK (
    NOT (kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED')
    OR reference_transaction_id IS NOT NULL
  );
`);
  }

  override async down(): Promise<void> {
    this.addSql(`
ALTER TABLE wager_transactions
  DROP CONSTRAINT IF EXISTS chk_processed_reversal_has_ref;
`);
  }
}
