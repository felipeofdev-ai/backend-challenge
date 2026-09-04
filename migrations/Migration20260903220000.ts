import { Migration } from "@mikro-orm/migrations";

/**
 * Forensic fix: original chk_ref_required used boolean equality
 *   (kind IN REFUND/ROLLBACK) = (reference IS NOT NULL)
 * which incorrectly rejects WIN/LOSS that carry an optional reference.
 *
 * Correct rule: REFUND/ROLLBACK require a reference; other kinds may omit or include one.
 */
export class Migration20260903220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
ALTER TABLE wager_transactions
  DROP CONSTRAINT IF EXISTS chk_ref_required;
`);
    this.addSql(`
ALTER TABLE wager_transactions
  ADD CONSTRAINT chk_ref_required CHECK (
    kind NOT IN ('REFUND', 'ROLLBACK')
    OR reference_external_transaction_id IS NOT NULL
  );
`);
  }

  override async down(): Promise<void> {
    this.addSql(`
ALTER TABLE wager_transactions
  DROP CONSTRAINT IF EXISTS chk_ref_required;
`);
    this.addSql(`
ALTER TABLE wager_transactions
  ADD CONSTRAINT chk_ref_required CHECK (
    (kind IN ('REFUND','ROLLBACK')) = (reference_external_transaction_id IS NOT NULL)
  );
`);
  }
}
