import { Migration } from "@mikro-orm/migrations";

/**
 * Bidirectional ledger invariant (challenge §5.9 / §6.2):
 * every PROCESSED balance-affecting transaction must have a ledger row.
 * DEFERRABLE so insert order (tx then ledger) inside one TX stays valid.
 */
export class Migration20260904010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE OR REPLACE FUNCTION assert_processed_tx_has_ledger() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'PROCESSED'
     AND NEW.kind <> 'LOSS'
     AND NOT EXISTS (
       SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'PROCESSED balance-affecting tx % has no ledger entry', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`);
    this.addSql(`
DROP TRIGGER IF EXISTS trg_processed_tx_has_ledger ON wager_transactions;
`);
    this.addSql(`
CREATE CONSTRAINT TRIGGER trg_processed_tx_has_ledger
  AFTER INSERT OR UPDATE OF status, kind ON wager_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_processed_tx_has_ledger();
`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_processed_tx_has_ledger ON wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS assert_processed_tx_has_ledger();`);
  }
}
