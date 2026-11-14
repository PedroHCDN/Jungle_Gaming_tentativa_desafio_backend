import { Money } from '../money/money';
import { LedgerDirection } from './ledger-direction';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

/**
 * Saldo reconstruído a partir do ledger: créditos somam, débitos subtraem,
 * partindo de zero (o saldo de abertura entra como lançamento `OPENING`).
 *
 * É a base da reconciliação e do invariante dos testes:
 * `wallet.balance == ledgerBalance(wallet.currency, entradas)`.
 * Lança `CurrencyMismatchError` se alguma entrada tiver outra moeda.
 */
export function ledgerBalance(
  currency: string,
  entries: readonly WalletLedgerEntry[],
): Money {
  let balance = Money.zero(currency);
  for (const entry of entries) {
    balance =
      entry.direction === LedgerDirection.Credit
        ? balance.add(entry.money)
        : balance.subtract(entry.money);
  }
  return balance;
}
