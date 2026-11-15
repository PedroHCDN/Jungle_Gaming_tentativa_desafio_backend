/**
 * Schema inicial do PostgreSQL, escrito à mão em SQL.
 *
 * As garantias financeiras ficam NO BANCO (unicidade, imutabilidade,
 * não-negatividade, consistência saldo x ledger), e não só no código da
 * aplicação. A migration do MikroORM apenas executa estas instruções.
 *
 * Regras de escrita deste arquivo:
 * - uma instrução por item (o corpo `$$ ... $$` das funções conta como uma);
 * - sem o caractere `?` e sem `:nome` fora de corpos PL/pgSQL, para o driver
 *   não confundir com parâmetros.
 */

export const UP_STATEMENTS: readonly string[] = [
  // ---------------------------------------------------------------------
  // Tipos e funções genéricas
  // ---------------------------------------------------------------------

  // Identificadores de texto vindos de fora: não vazios, até 255 caracteres.
  `CREATE DOMAIN ext_id AS text
     CONSTRAINT ext_id_valid
     CHECK (VALUE ~ '[^[:space:]]' AND length(VALUE) <= 255)`,

  // Bloqueia a operação que dispara o trigger (UPDATE/DELETE/TRUNCATE).
  `CREATE FUNCTION forbid_mutation() RETURNS trigger
   LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'operation % is not allowed on %', TG_OP, TG_TABLE_NAME
       USING ERRCODE = 'integrity_constraint_violation';
   END;
   $$`,

  // ---------------------------------------------------------------------
  // wallets
  // ---------------------------------------------------------------------
  `CREATE TABLE wallets (
     id          uuid          PRIMARY KEY,
     player_id   ext_id        NOT NULL,
     currency    char(3)       NOT NULL,
     balance     numeric(19,2) NOT NULL,
     version     integer       NOT NULL DEFAULT 1,
     created_at  timestamptz   NOT NULL,
     updated_at  timestamptz   NOT NULL,
     CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
     -- alvo da chave estrangeira composta do ledger (moeda da wallet)
     CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency),
     CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
     CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
     CONSTRAINT wallets_version_positive CHECK (version >= 1)
   ) WITH (fillfactor = 70)`,

  // Identidade imutável; a versão só muda junto com o saldo (+1).
  // Uma versão defasada é um conflito de concorrência (SQLSTATE 40001).
  `CREATE FUNCTION wallets_guard() RETURNS trigger
   LANGUAGE plpgsql AS $$
   BEGIN
     IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at)
     THEN
       RAISE EXCEPTION 'wallets: id, player_id, currency and created_at are immutable'
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     IF NEW.balance IS DISTINCT FROM OLD.balance THEN
       IF NEW.version <> OLD.version + 1 THEN
         RAISE EXCEPTION 'wallets: stale version, a balance change requires version % but got %',
           OLD.version + 1, NEW.version
           USING ERRCODE = 'serialization_failure';
       END IF;
     ELSIF NEW.version <> OLD.version THEN
       RAISE EXCEPTION 'wallets: version changes only together with the balance'
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     RETURN NEW;
   END;
   $$`,
  `CREATE TRIGGER wallets_guard
     BEFORE UPDATE ON wallets
     FOR EACH ROW EXECUTE FUNCTION wallets_guard()`,
  `CREATE TRIGGER wallets_no_delete
     BEFORE DELETE ON wallets
     FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
  `CREATE TRIGGER wallets_no_truncate
     BEFORE TRUNCATE ON wallets
     FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

  // ---------------------------------------------------------------------
  // wager_transactions
  // ---------------------------------------------------------------------
  `CREATE TABLE wager_transactions (
     id                                 uuid          PRIMARY KEY,
     provider_id                        ext_id        NOT NULL,
     external_transaction_id            ext_id        NOT NULL,
     idempotency_key                    ext_id        NOT NULL,
     payload_hash                       char(64)      NOT NULL,
     wallet_id                          uuid          NOT NULL REFERENCES wallets (id),
     player_id                          ext_id        NOT NULL,
     round_id                           ext_id        NOT NULL,
     game_id                            ext_id        NOT NULL,
     kind                               text          NOT NULL,
     amount                             numeric(19,2) NOT NULL,
     currency                           char(3)       NOT NULL,
     reference_external_transaction_id  ext_id,
     reference_transaction_id           uuid,
     status                             text          NOT NULL DEFAULT 'PENDING',
     failure_code                       text,
     reference_attempts                 integer       NOT NULL DEFAULT 0,
     next_attempt_at                    timestamptz,
     created_at                         timestamptz   NOT NULL,
     processed_at                       timestamptz,

     -- unicidade: dedup persistente da operação e da chave de idempotência
     CONSTRAINT wager_transactions_provider_external_uq
       UNIQUE (provider_id, external_transaction_id),
     -- por provider: a chave de um provider nunca colide nem revela a de outro
     CONSTRAINT wager_transactions_idempotency_key_uq
       UNIQUE (provider_id, idempotency_key),
     -- alvo da chave estrangeira composta do ledger (wallet da transação)
     CONSTRAINT wager_transactions_id_wallet_uq UNIQUE (id, wallet_id),
     -- a referência resolvida é uma transação da MESMA wallet
     CONSTRAINT wager_transactions_reference_fk
       FOREIGN KEY (reference_transaction_id, wallet_id)
       REFERENCES wager_transactions (id, wallet_id),

     -- formatos e domínios
     CONSTRAINT wager_transactions_kind_valid
       CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
     CONSTRAINT wager_transactions_status_valid
       CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
     CONSTRAINT wager_transactions_payload_hash_format
       CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
     CONSTRAINT wager_transactions_currency_format
       CHECK (currency ~ '^[A-Z]{3}$'),
     CONSTRAINT wager_transactions_failure_code_format
       CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z_]*$'),

     -- valor: nunca negativo; só LOSS aceita zero
     CONSTRAINT wager_transactions_amount_valid
       CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),

     -- referência por tipo de operação
     CONSTRAINT wager_transactions_reference_required
       CHECK (kind NOT IN ('REFUND','ROLLBACK')
              OR reference_external_transaction_id IS NOT NULL),
     CONSTRAINT wager_transactions_reference_forbidden
       CHECK (kind NOT IN ('OPENING','BET')
              OR reference_external_transaction_id IS NULL),
     CONSTRAINT wager_transactions_no_self_reference
       CHECK (reference_external_transaction_id IS DISTINCT FROM external_transaction_id
              AND (reference_transaction_id IS NULL OR reference_transaction_id <> id)),
     CONSTRAINT wager_transactions_reference_resolved_when_processed
       CHECK (reference_transaction_id IS NULL
              OR (reference_external_transaction_id IS NOT NULL AND status = 'PROCESSED')),
     CONSTRAINT wager_transactions_reversal_processed_has_reference
       CHECK (status <> 'PROCESSED'
              OR kind NOT IN ('REFUND','ROLLBACK')
              OR reference_transaction_id IS NOT NULL),

     -- coerência do estado
     CONSTRAINT wager_transactions_failure_code_matches_status
       CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
     CONSTRAINT wager_transactions_processed_at_matches_status
       CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
     -- PENDING_REFERENCE sempre tem a próxima tentativa agendada (senão a
     -- linha nunca seria reprocessada) e nenhum outro status tem
     CONSTRAINT wager_transactions_retry_state_valid
       CHECK (reference_attempts >= 0
              AND ((status = 'PENDING_REFERENCE') = (next_attempt_at IS NOT NULL)))
   )`,

  // Lista as transações de uma wallet (também indexa a chave estrangeira).
  `CREATE INDEX wager_transactions_wallet_idx
     ON wager_transactions (wallet_id, created_at)`,

  // Uma referência só pode ser revertida UMA vez (por REFUND ou ROLLBACK).
  // WIN pode referenciar a mesma BET várias vezes, por isso fica de fora.
  `CREATE UNIQUE INDEX wager_transactions_reversal_uq
     ON wager_transactions (reference_transaction_id)
     WHERE kind IN ('REFUND','ROLLBACK') AND reference_transaction_id IS NOT NULL`,

  // Worker de PENDING_REFERENCE: o que está vencido para reprocessar.
  `CREATE INDEX wager_transactions_pending_reference_due_idx
     ON wager_transactions (next_attempt_at)
     WHERE status = 'PENDING_REFERENCE'`,

  // Quando uma referência chega: quem estava esperando por ela.
  `CREATE INDEX wager_transactions_waiting_for_reference_idx
     ON wager_transactions (provider_id, reference_external_transaction_id)
     WHERE status = 'PENDING_REFERENCE'`,

  // Transações são auditáveis: o estado terminal não muda mais e a
  // identidade da operação é imutável.
  `CREATE FUNCTION wager_transactions_guard() RETURNS trigger
   LANGUAGE plpgsql AS $$
   BEGIN
     IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
       RAISE EXCEPTION 'wager_transactions: % is a terminal status and the row cannot change', OLD.status
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     IF (NEW.id, NEW.provider_id, NEW.external_transaction_id,
         NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id, NEW.player_id,
         NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
         NEW.reference_external_transaction_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.provider_id, OLD.external_transaction_id,
         OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id, OLD.player_id,
         OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
         OLD.reference_external_transaction_id, OLD.created_at)
     THEN
       RAISE EXCEPTION 'wager_transactions: the identity of a transaction is immutable'
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
       RAISE EXCEPTION 'wager_transactions: cannot go back to PENDING from %', OLD.status
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     RETURN NEW;
   END;
   $$`,
  `CREATE TRIGGER wager_transactions_guard
     BEFORE UPDATE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()`,
  `CREATE TRIGGER wager_transactions_no_delete
     BEFORE DELETE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
  `CREATE TRIGGER wager_transactions_no_truncate
     BEFORE TRUNCATE ON wager_transactions
     FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

  // ---------------------------------------------------------------------
  // wallet_ledger_entries (append-only)
  // ---------------------------------------------------------------------
  `CREATE TABLE wallet_ledger_entries (
     id              uuid          PRIMARY KEY,
     -- ordem total e estável dos lançamentos (cursor da API e cadeia de saldos)
     seq             bigint        GENERATED ALWAYS AS IDENTITY,
     wallet_id       uuid          NOT NULL,
     transaction_id  uuid          NOT NULL,
     direction       text          NOT NULL,
     amount          numeric(19,2) NOT NULL,
     currency        char(3)       NOT NULL,
     balance_before  numeric(19,2) NOT NULL,
     balance_after   numeric(19,2) NOT NULL,
     created_at      timestamptz   NOT NULL,

     -- no máximo um lançamento por wallet por transação
     CONSTRAINT wallet_ledger_entries_transaction_wallet_uq
       UNIQUE (transaction_id, wallet_id),
     -- o lançamento está na moeda da wallet e na wallet da transação
     CONSTRAINT wallet_ledger_entries_wallet_currency_fk
       FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
     CONSTRAINT wallet_ledger_entries_transaction_wallet_fk
       FOREIGN KEY (transaction_id, wallet_id)
       REFERENCES wager_transactions (id, wallet_id),

     CONSTRAINT wallet_ledger_entries_direction_valid
       CHECK (direction IN ('DEBIT','CREDIT')),
     CONSTRAINT wallet_ledger_entries_currency_format
       CHECK (currency ~ '^[A-Z]{3}$'),
     CONSTRAINT wallet_ledger_entries_amount_positive
       CHECK (amount > 0),
     CONSTRAINT wallet_ledger_entries_balances_non_negative
       CHECK (balance_before >= 0 AND balance_after >= 0),
     -- balance_before +/- amount = balance_after
     CONSTRAINT wallet_ledger_entries_arithmetic
       CHECK ((direction = 'CREDIT' AND balance_before + amount = balance_after)
              OR (direction = 'DEBIT' AND balance_before - amount = balance_after))
   )`,

  `CREATE UNIQUE INDEX wallet_ledger_entries_wallet_seq_uq
     ON wallet_ledger_entries (wallet_id, seq)`,

  // Imutabilidade: nenhum UPDATE, DELETE ou TRUNCATE no ledger.
  `CREATE TRIGGER wallet_ledger_entries_immutable
     BEFORE UPDATE OR DELETE ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
  `CREATE TRIGGER wallet_ledger_entries_no_truncate
     BEFORE TRUNCATE ON wallet_ledger_entries
     FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,

  // ---------------------------------------------------------------------
  // Consistência entre saldo materializado, ledger e transações.
  // São constraint triggers ADIADOS: rodam no COMMIT, quando a transação
  // inteira (wallet + transação + ledger) já está gravada. Cada um relê o
  // estado atual das linhas, então vários updates na mesma transação
  // continuam corretos.
  // ---------------------------------------------------------------------

  // (1) Cada lançamento encadeia no anterior, corresponde à sua transação
  // (e à transação referenciada) e deixa a wallet com o saldo do ledger.
  `CREATE FUNCTION wallet_ledger_entries_verify() RETURNS trigger
   LANGUAGE plpgsql AS $$
   DECLARE
     previous_after     numeric(19,2);
     latest_after       numeric(19,2);
     wallet_balance     numeric(19,2);
     tx                 RECORD;
     referenced         RECORD;
     expected_direction text;
   BEGIN
     -- cadeia: o saldo anterior é o saldo posterior do lançamento anterior
     SELECT e.balance_after INTO previous_after
       FROM wallet_ledger_entries e
      WHERE e.wallet_id = NEW.wallet_id AND e.seq < NEW.seq
      ORDER BY e.seq DESC
      LIMIT 1;
     IF NOT FOUND THEN
       previous_after := 0;
     END IF;
     IF NEW.balance_before <> previous_after THEN
       RAISE EXCEPTION 'wallet_ledger_entries: chain broken for wallet %, balance_before % but the previous balance_after is %',
         NEW.wallet_id, NEW.balance_before, previous_after
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     -- a transação do lançamento
     SELECT t.kind, t.status, t.amount, t.currency, t.reference_transaction_id
       INTO tx
       FROM wager_transactions t
      WHERE t.id = NEW.transaction_id;
     IF tx.status <> 'PROCESSED' OR tx.kind = 'LOSS' THEN
       RAISE EXCEPTION 'wallet_ledger_entries: the transaction must be PROCESSED and affect the balance (kind %, status %)',
         tx.kind, tx.status
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;
     IF NEW.amount <> tx.amount OR NEW.currency <> tx.currency THEN
       RAISE EXCEPTION 'wallet_ledger_entries: amount and currency must match the transaction'
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     -- a transação referenciada (a wallet já é a mesma pela FK composta)
     IF tx.reference_transaction_id IS NOT NULL THEN
       SELECT r.kind, r.status, r.amount, r.currency
         INTO referenced
         FROM wager_transactions r
        WHERE r.id = tx.reference_transaction_id;
       IF referenced.status <> 'PROCESSED' THEN
         RAISE EXCEPTION 'wallet_ledger_entries: the referenced transaction must be PROCESSED (status %)',
           referenced.status
           USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF NOT ((tx.kind = 'REFUND' AND referenced.kind = 'BET')
            OR (tx.kind = 'ROLLBACK' AND referenced.kind IN ('BET','WIN','REFUND'))
            OR (tx.kind = 'WIN' AND referenced.kind = 'BET')) THEN
         RAISE EXCEPTION 'wallet_ledger_entries: a % cannot reference a %', tx.kind, referenced.kind
           USING ERRCODE = 'integrity_constraint_violation';
       END IF;
       IF tx.kind IN ('REFUND','ROLLBACK')
          AND (referenced.amount <> tx.amount OR referenced.currency <> tx.currency) THEN
         RAISE EXCEPTION 'wallet_ledger_entries: a reversal must have the same amount and currency as its reference'
           USING ERRCODE = 'integrity_constraint_violation';
       END IF;
     END IF;

     -- direção: BET debita; WIN, REFUND e OPENING creditam; ROLLBACK inverte
     IF tx.kind = 'ROLLBACK' THEN
       expected_direction :=
         CASE WHEN referenced.kind = 'BET' THEN 'CREDIT' ELSE 'DEBIT' END;
     ELSE
       expected_direction :=
         CASE WHEN tx.kind = 'BET' THEN 'DEBIT' ELSE 'CREDIT' END;
     END IF;
     IF NEW.direction <> expected_direction THEN
       RAISE EXCEPTION 'wallet_ledger_entries: a % requires direction % but got %',
         tx.kind, expected_direction, NEW.direction
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     -- o saldo da wallet precisa ser o do último lançamento (inclusive
     -- quando a aplicação gravou o lançamento e esqueceu de atualizar a wallet)
     SELECT w.balance INTO wallet_balance FROM wallets w WHERE w.id = NEW.wallet_id;
     SELECT e.balance_after INTO latest_after
       FROM wallet_ledger_entries e
      WHERE e.wallet_id = NEW.wallet_id
      ORDER BY e.seq DESC
      LIMIT 1;
     IF wallet_balance <> latest_after THEN
       RAISE EXCEPTION 'wallets: balance % does not match the ledger (last balance_after %)',
         wallet_balance, latest_after
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     RETURN NULL;
   END;
   $$`,
  `CREATE CONSTRAINT TRIGGER wallet_ledger_entries_verify
     AFTER INSERT ON wallet_ledger_entries
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION wallet_ledger_entries_verify()`,

  // (2) O saldo da wallet é o balance_after do último lançamento (ou 0).
  // Com a cadeia do item (1), isso fecha: saldo = soma do ledger.
  `CREATE FUNCTION wallets_verify_balance() RETURNS trigger
   LANGUAGE plpgsql AS $$
   DECLARE
     current_balance numeric(19,2);
     ledger_balance  numeric(19,2);
   BEGIN
     SELECT w.balance INTO current_balance FROM wallets w WHERE w.id = NEW.id;

     SELECT e.balance_after INTO ledger_balance
       FROM wallet_ledger_entries e
      WHERE e.wallet_id = NEW.id
      ORDER BY e.seq DESC
      LIMIT 1;
     IF NOT FOUND THEN
       ledger_balance := 0;
     END IF;

     IF current_balance <> ledger_balance THEN
       RAISE EXCEPTION 'wallets: balance % does not match the ledger (last balance_after %)',
         current_balance, ledger_balance
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     RETURN NULL;
   END;
   $$`,
  `CREATE CONSTRAINT TRIGGER wallets_verify_balance
     AFTER INSERT OR UPDATE OF balance ON wallets
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION wallets_verify_balance()`,

  // (3) Toda transação PROCESSED que move saldo tem o seu lançamento.
  `CREATE FUNCTION wager_transactions_verify_ledger() RETURNS trigger
   LANGUAGE plpgsql AS $$
   DECLARE
     tx RECORD;
   BEGIN
     SELECT t.status, t.kind INTO tx FROM wager_transactions t WHERE t.id = NEW.id;

     IF tx.status = 'PROCESSED' AND tx.kind <> 'LOSS' AND NOT EXISTS (
       SELECT 1 FROM wallet_ledger_entries e WHERE e.transaction_id = NEW.id
     ) THEN
       RAISE EXCEPTION 'wager_transactions: a PROCESSED % transaction has no ledger entry', tx.kind
         USING ERRCODE = 'integrity_constraint_violation';
     END IF;

     RETURN NULL;
   END;
   $$`,
  `CREATE CONSTRAINT TRIGGER wager_transactions_verify_ledger
     AFTER INSERT OR UPDATE OF status ON wager_transactions
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION wager_transactions_verify_ledger()`,

  // ---------------------------------------------------------------------
  // inbox / outbox
  // ---------------------------------------------------------------------
  `CREATE TABLE inbox_messages (
     consumer_name  ext_id      NOT NULL,
     message_id     ext_id      NOT NULL,
     payload_hash   char(64)    NOT NULL,
     received_at    timestamptz NOT NULL,
     processed_at   timestamptz,
     CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id),
     CONSTRAINT inbox_messages_payload_hash_format
       CHECK (payload_hash ~ '^[0-9a-f]{64}$')
   )`,

  `CREATE TABLE outbox_messages (
     id               uuid        PRIMARY KEY,
     -- ordem de publicação estável (os relógios das instâncias podem divergir)
     seq              bigint      GENERATED ALWAYS AS IDENTITY,
     aggregate_id     ext_id      NOT NULL,
     event_type       ext_id      NOT NULL,
     payload          jsonb       NOT NULL,
     occurred_at      timestamptz NOT NULL,
     attempts         integer     NOT NULL DEFAULT 0,
     next_attempt_at  timestamptz,
     published_at     timestamptz,
     CONSTRAINT outbox_messages_payload_is_object
       CHECK (jsonb_typeof(payload) = 'object'),
     CONSTRAINT outbox_messages_attempts_non_negative
       CHECK (attempts >= 0)
   )`,

  // O publisher varre só o que ainda não foi publicado, na ordem de seq (e
  // o lag da outbox é o occurred_at mais antigo desse conjunto).
  `CREATE INDEX outbox_messages_unpublished_idx
     ON outbox_messages (seq)
     WHERE published_at IS NULL`,
];

export const DOWN_STATEMENTS: readonly string[] = [
  `DROP TABLE IF EXISTS outbox_messages`,
  `DROP TABLE IF EXISTS inbox_messages`,
  `DROP TABLE IF EXISTS wallet_ledger_entries`,
  `DROP TABLE IF EXISTS wager_transactions`,
  `DROP TABLE IF EXISTS wallets`,
  `DROP FUNCTION IF EXISTS wager_transactions_verify_ledger()`,
  `DROP FUNCTION IF EXISTS wager_transactions_guard()`,
  `DROP FUNCTION IF EXISTS wallets_verify_balance()`,
  `DROP FUNCTION IF EXISTS wallets_guard()`,
  `DROP FUNCTION IF EXISTS wallet_ledger_entries_verify()`,
  `DROP FUNCTION IF EXISTS forbid_mutation()`,
  `DROP DOMAIN IF EXISTS ext_id`,
];
