import { randomUUID } from 'node:crypto';
import type { TransactionRunner } from '../../../src/application/ports/persistence';
import { LedgerDirection } from '../../../src/domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../src/domain/money/money';
import { WagerTransaction } from '../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { SqlLedgerRepository } from '../../../src/infrastructure/persistence/repositories/ledger.repository';
import { SqlWagerTransactionRepository } from '../../../src/infrastructure/persistence/repositories/wager-transaction.repository';
import { SqlWalletRepository } from '../../../src/infrastructure/persistence/repositories/wallet.repository';

export interface OpenedWallet {
  walletId: string;
  playerId: string;
}

/** Abre uma wallet com saldo: wallet + OPENING + lançamento, numa transação. */
export async function openWallet(
  runner: TransactionRunner,
  initial: string,
  currency = 'BRL',
): Promise<OpenedWallet> {
  const wallets = new SqlWalletRepository();
  const transactions = new SqlWagerTransactionRepository();
  const ledger = new SqlLedgerRepository();
  const now = new Date();
  const wallet = Wallet.open({
    id: randomUUID(),
    playerId: `player-${randomUUID()}`,
    initialBalance: Money.from({ amount: initial, currency }),
    now,
  });

  await runner.run(async (db) => {
    await wallets.insert(db, wallet);
    const opening = WagerTransaction.createOpening({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: wallet.balance,
      now,
    });
    await transactions.insertIfAbsent(db, opening);
    await ledger.append(
      db,
      WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: wallet.balance,
        balanceBefore: Money.zero(currency),
        balanceAfter: wallet.balance,
        createdAt: now,
      }),
    );
    opening.markProcessed(undefined, now);
    await transactions.saveTransition(db, opening);
  });

  return { walletId: wallet.id, playerId: wallet.playerId };
}
