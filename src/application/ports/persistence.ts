import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

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
  /** Persiste status, referência resolvida, failureCode e processedAt. */
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
