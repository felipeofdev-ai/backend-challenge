import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema with financial invariants enforced in the database.
 * Guarantees live in CHECKs, UNIQUE indexes, partial unique indexes, and triggers —
 * not only in application code (challenge §5).
 */
export class Migration20260903210000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
CREATE TABLE wallets (
    id            UUID PRIMARY KEY,
    player_id     UUID          NOT NULL,
    currency      CHAR(3)       NOT NULL,
    balance       NUMERIC(38,2) NOT NULL CHECK (balance >= 0),
    version       BIGINT        NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ   NOT NULL,
    updated_at    TIMESTAMPTZ   NOT NULL,
    CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
);
`);

    this.addSql(`
CREATE TABLE wager_transactions (
    id                                UUID PRIMARY KEY,
    provider_id                       VARCHAR(64)   NOT NULL,
    external_transaction_id           VARCHAR(128)  NOT NULL,
    idempotency_key                   VARCHAR(255)  NOT NULL,
    payload_hash                      CHAR(64)      NOT NULL,
    wallet_id                         UUID          NOT NULL REFERENCES wallets(id),
    player_id                         UUID          NOT NULL,
    round_id                          VARCHAR(128)  NOT NULL,
    game_id                           VARCHAR(128)  NOT NULL,
    kind                              VARCHAR(16)   NOT NULL
        CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
    status                            VARCHAR(32)   NOT NULL
        CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
    amount                            NUMERIC(38,2) NOT NULL CHECK (amount > 0),
    currency                          CHAR(3)       NOT NULL,
    reference_external_transaction_id VARCHAR(128),
    reference_transaction_id          UUID REFERENCES wager_transactions(id),
    failure_code                      VARCHAR(64),
    result_balance                    NUMERIC(38,2),
    reference_attempts                INT           NOT NULL DEFAULT 0,
    next_reprocess_at                 TIMESTAMPTZ,
    reprocess_deadline                TIMESTAMPTZ,
    created_at                        TIMESTAMPTZ   NOT NULL,
    processed_at                      TIMESTAMPTZ,
    CONSTRAINT chk_ref_required CHECK (
        kind NOT IN ('REFUND', 'ROLLBACK')
        OR reference_external_transaction_id IS NOT NULL
    ),
    CONSTRAINT chk_terminal_has_code CHECK (
        status <> 'REJECTED' OR failure_code IS NOT NULL
    ),
    CONSTRAINT chk_result_balance_nonneg CHECK (
        result_balance IS NULL OR result_balance >= 0
    )
);
`);

    this.addSql(`
CREATE UNIQUE INDEX uq_wager_tx_idempotency
    ON wager_transactions (provider_id, idempotency_key);
`);
    this.addSql(`
CREATE UNIQUE INDEX uq_wager_tx_external
    ON wager_transactions (provider_id, external_transaction_id);
`);
    this.addSql(`
CREATE INDEX ix_wager_tx_reference
    ON wager_transactions (provider_id, reference_external_transaction_id)
    WHERE reference_external_transaction_id IS NOT NULL;
`);
    this.addSql(`
CREATE INDEX ix_wager_tx_pending_ref
    ON wager_transactions (next_reprocess_at)
    WHERE status = 'PENDING_REFERENCE';
`);
    // Single effective reversal per reference (ADR-007)
    this.addSql(`
CREATE UNIQUE INDEX uq_refund_ref_unique
    ON wager_transactions (reference_transaction_id)
    WHERE kind = 'REFUND' AND status = 'PROCESSED';
`);
    this.addSql(`
CREATE UNIQUE INDEX uq_rollback_ref_unique
    ON wager_transactions (reference_transaction_id)
    WHERE kind = 'ROLLBACK' AND status = 'PROCESSED';
`);
    this.addSql(`
CREATE UNIQUE INDEX uq_reversal_ref_unique
    ON wager_transactions (reference_transaction_id)
    WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
`);

    this.addSql(`
CREATE TABLE wallet_ledger_entries (
    id             UUID PRIMARY KEY,
    wallet_id      UUID          NOT NULL REFERENCES wallets(id),
    transaction_id UUID          NOT NULL REFERENCES wager_transactions(id),
    direction      VARCHAR(8)    NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
    amount         NUMERIC(38,2) NOT NULL CHECK (amount > 0),
    currency       CHAR(3)       NOT NULL,
    balance_before NUMERIC(38,2) NOT NULL CHECK (balance_before >= 0),
    balance_after  NUMERIC(38,2) NOT NULL CHECK (balance_after  >= 0),
    created_at     TIMESTAMPTZ   NOT NULL,
    CONSTRAINT chk_ledger_balanced CHECK (
        (direction = 'DEBIT'  AND balance_before - amount = balance_after) OR
        (direction = 'CREDIT' AND balance_before + amount = balance_after)
    ),
    CONSTRAINT uq_ledger_tx UNIQUE (transaction_id)
);
`);

    this.addSql(`
CREATE OR REPLACE FUNCTION assert_ledger_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'ledger entries are immutable (id: %)', OLD.id;
END;
$$ LANGUAGE plpgsql;
`);
    this.addSql(`
CREATE TRIGGER trg_ledger_immutable
    BEFORE UPDATE OR DELETE ON wallet_ledger_entries
    FOR EACH ROW EXECUTE FUNCTION assert_ledger_immutable();
`);

    this.addSql(`
CREATE TABLE inbox_messages (
    consumer_name VARCHAR(64)  NOT NULL,
    message_id    VARCHAR(255) NOT NULL,
    payload_hash  CHAR(64)     NOT NULL,
    received_at   TIMESTAMPTZ  NOT NULL,
    processed_at  TIMESTAMPTZ,
    PRIMARY KEY (consumer_name, message_id)
);
`);

    this.addSql(`
CREATE TABLE outbox_messages (
    id              UUID PRIMARY KEY,
    aggregate_id    UUID        NOT NULL,
    event_type      VARCHAR(64) NOT NULL,
    version         INT         NOT NULL,
    payload         JSONB       NOT NULL,
    correlation_id  UUID        NOT NULL,
    causation_id    UUID,
    occurred_at     TIMESTAMPTZ NOT NULL,
    attempts        INT         NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL
);
`);
    this.addSql(`
CREATE INDEX ix_outbox_pending
    ON outbox_messages (next_attempt_at)
    WHERE published_at IS NULL;
`);

    this.addSql(`
CREATE TABLE reconciliation_checks (
    id                  UUID PRIMARY KEY,
    wallet_id           UUID          NOT NULL REFERENCES wallets(id),
    stored_balance      NUMERIC(38,2) NOT NULL,
    calculated_balance  NUMERIC(38,2) NOT NULL,
    difference          NUMERIC(38,2) NOT NULL,
    consistent          BOOLEAN       NOT NULL,
    checked_entries     INT           NOT NULL,
    created_at          TIMESTAMPTZ   NOT NULL
);
`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS reconciliation_checks;`);
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_ledger_immutable ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS assert_ledger_immutable();`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
