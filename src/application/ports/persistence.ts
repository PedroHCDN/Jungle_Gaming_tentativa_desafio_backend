import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { IntegrationEvent } from '../events/integration-event';

/**
 * Sessão de banco: dentro de `TransactionRunner.run` é a transação aberta;
 * em `read` é uma sessão avulsa. Os repositories sempre recebem a sessão,
 * então é o caso de uso quem define a fronteira da transação.
 *
 * Placeholders são `?` (convenção do MikroORM) e as linhas voltam como objetos
 * com o nome da coluna.
 */
export interface DbSession {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<T[]>;
}

export interface TransactionRunner {
  /** Executa `work` em UMA transação: commit se resolver, rollback se lançar. */
  run<T>(work: (db: DbSession) => Promise<T>): Promise<T>;
  /** Leitura fora de transação. */
  read<T>(work: (db: DbSession) => Promise<T>): Promise<T>;
}

/** A wallet mudou desde que foi lida (versão otimista não confere). */
export class StaleWalletError extends Error {
  constructor(public readonly walletId: string) {
    super(`wallet ${walletId} was modified concurrently (stale version)`);
    this.name = 'StaleWalletError';
  }
}

/** A transação não foi encontrada ao salvar uma transição de estado. */
export class TransactionNotFoundError extends Error {
  constructor(public readonly transactionId: string) {
    super(`wager transaction ${transactionId} not found`);
    this.name = 'TransactionNotFoundError';
  }
}

export interface WalletRepository {
  insert(db: DbSession, wallet: Wallet): Promise<void>;
  findById(db: DbSession, id: string): Promise<Wallet | undefined>;
  /**
   * `SELECT … FOR NO KEY UPDATE`: trava a linha até o fim da transação
   * (serializa escritores sem deadlock com os INSERTs filhos que têm FK
   * para a wallet). Todo escritor DEVE usar este método antes de ler o
   * saldo (lock-first).
   */
  findByIdForUpdate(db: DbSession, id: string): Promise<Wallet | undefined>;
  /**
   * Grava UM movimento de saldo (a wallet deve ter acabado de aplicar
   * `debit`/`credit`). Falha com `StaleWalletError` se a versão no banco
   * não for `wallet.version - 1`.
   */
  saveMovement(db: DbSession, wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  /**
   * `INSERT … ON CONFLICT DO NOTHING`. `false` se já existe uma transação
   * com o mesmo `(provider, external id)` ou `(provider, idempotency key)`;
   * nesse caso o chamador busca a existente e compara o `payloadHash`.
   */
  insertIfAbsent(
    db: DbSession,
    transaction: WagerTransaction,
  ): Promise<boolean>;
  findById(db: DbSession, id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(
    db: DbSession,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(
    db: DbSession,
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  /** A reversão (REFUND/ROLLBACK) já aplicada sobre esta transação, se houver. */
  findReversalOf(
    db: DbSession,
    referenceTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /**
   * Persiste status, referência resolvida, failureCode, processedAt e o estado
   * de espera (tentativas e próxima tentativa).
   */
  saveTransition(db: DbSession, transaction: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  /** Só existe `append`: o ledger é imutável (e o banco recusa UPDATE/DELETE). */
  append(db: DbSession, entry: WalletLedgerEntry): Promise<void>;
  /** Em ordem de inserção (`seq`). */
  findByWalletId(db: DbSession, walletId: string): Promise<WalletLedgerEntry[]>;
  findByTransactionId(
    db: DbSession,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined>;
}

export interface OutboxRepository {
  /**
   * Grava o evento na outbox DENTRO da transação do efeito financeiro: ou os
   * dois acontecem, ou nenhum. A publicação (depois do commit) é da Fase 5.
   */
  append(db: DbSession, event: IntegrationEvent): Promise<void>;
}

/** Identidade de uma mensagem de entrada (SQS): `(consumerName, messageId)` é única. */
export interface InboxMessage {
  consumerName: string;
  messageId: string;
  /** Hash do payload de negócio: detecta o mesmo messageId com conteúdo diferente. */
  payloadHash: string;
  receivedAt: Date;
}

export type InboxRegistration =
  | { registered: true }
  /** Já registrada antes: devolve o hash do payload que foi registrado. */
  | { registered: false; payloadHash: string };

export interface InboxRepository {
  /**
   * `INSERT … ON CONFLICT DO NOTHING` na transação do efeito. Como a linha só
   * fica visível se o efeito foi commitado, "já registrada" significa "já
   * processada". Entregas simultâneas da mesma mensagem esperam o commit da
   * primeira (índice único) e então veem `registered: false`.
   */
  register(db: DbSession, message: InboxMessage): Promise<InboxRegistration>;
}
