import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerDirection } from '../ledger/ledger-direction';
import { Money } from '../money/money';
import {
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../shared/domain-error';
import { FailureCode } from './failure-code';
import {
  CreateWagerTransactionProps,
  isValidTransition,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction';

const t0 = new Date('2026-01-01T00:00:00.000Z');
const t1 = new Date('2026-01-01T00:00:01.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let seq = 0;
function make(
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  seq += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${seq}`;
  return WagerTransaction.create({
    id: `id-${seq}`,
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    now: t0,
    ...overrides,
  });
}

const bet = (ext = 'bet-1', amount = '25.00') =>
  make({ externalTransactionId: ext, kind: Kind.Bet, money: brl(amount) });

describe('WagerTransaction.create', () => {
  it('nasce PENDING, com hash calculado e sem falha nem processedAt', () => {
    const tx = make();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
    expect(tx.createdAt).toEqual(t0);
  });

  it('rejeita OPENING vindo de fora', () => {
    expect(() => make({ kind: Kind.Opening })).toThrow(InvalidTransactionError);
  });

  it.each([Kind.Refund, Kind.Rollback])('%s exige referência', (kind) => {
    expect(() => make({ kind })).toThrow(InvalidTransactionError);
    expect(() => make({ kind, referenceExternalTransactionId: '  ' })).toThrow(
      InvalidTransactionError,
    );
    expect(() =>
      make({ kind, referenceExternalTransactionId: 'bet-1' }),
    ).not.toThrow();
  });

  it('BET não pode ter referência; WIN e LOSS podem ter', () => {
    expect(() =>
      make({ kind: Kind.Bet, referenceExternalTransactionId: 'x' }),
    ).toThrow(InvalidTransactionError);
    expect(() =>
      make({ kind: Kind.Win, referenceExternalTransactionId: 'x' }),
    ).not.toThrow();
    expect(() => make({ kind: Kind.Win })).not.toThrow();
    expect(() =>
      make({ kind: Kind.Loss, referenceExternalTransactionId: 'x' }),
    ).not.toThrow();
  });

  it('não permite referenciar a si mesma', () => {
    expect(() =>
      make({
        externalTransactionId: 'same',
        kind: Kind.Refund,
        referenceExternalTransactionId: 'same',
      }),
    ).toThrow(InvalidTransactionError);
  });

  it('exige valor positivo, exceto LOSS que aceita zero', () => {
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(() => make({ kind, money: Money.zero('BRL') })).toThrow(
        InvalidTransactionError,
      );
    }
    expect(() =>
      make({
        kind: Kind.Refund,
        referenceExternalTransactionId: 'b',
        money: Money.zero('BRL'),
      }),
    ).toThrow(InvalidTransactionError);
    expect(() =>
      make({ kind: Kind.Loss, money: Money.zero('BRL') }),
    ).not.toThrow();
    expect(() =>
      make({ kind: Kind.Loss, money: brl('1.00').negate() }),
    ).toThrow(InvalidTransactionError);
  });

  it.each([
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
    'id',
  ] as const)('rejeita %s vazio ou só com espaços', (field) => {
    expect(() => make({ [field]: '' })).toThrow(InvalidTransactionError);
    expect(() => make({ [field]: '   ' })).toThrow(InvalidTransactionError);
  });

  it('rejeita identificador maior que 255 caracteres', () => {
    expect(() => make({ roundId: 'r'.repeat(256) })).toThrow(
      InvalidTransactionError,
    );
    expect(() => make({ roundId: 'r'.repeat(255) })).not.toThrow();
  });
});

describe('WagerTransaction.createOpening', () => {
  it('cria a transação interna OPENING', () => {
    const tx = WagerTransaction.createOpening({
      id: 'open-1',
      walletId: 'wallet-9',
      playerId: 'player-9',
      money: brl('1000.00'),
      now: t0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.providerId).toBe('system');
    expect(tx.idempotencyKey).toBe('opening:wallet-9');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
  });

  it('exige valor positivo', () => {
    expect(() =>
      WagerTransaction.createOpening({
        id: 'o',
        walletId: 'w',
        playerId: 'p',
        money: Money.zero('BRL'),
      }),
    ).toThrow(InvalidTransactionError);
  });
});

describe('máquina de estados', () => {
  const all = Object.values(Status);
  const allowed: Record<Status, Status[]> = {
    [Status.Pending]: [
      Status.PendingReference,
      Status.Processed,
      Status.Rejected,
      Status.Failed,
    ],
    [Status.PendingReference]: [
      Status.PendingReference,
      Status.Processed,
      Status.Rejected,
      Status.Failed,
    ],
    [Status.Processed]: [],
    [Status.Rejected]: [],
    [Status.Failed]: [],
  };

  it('isValidTransition cobre as 25 combinações', () => {
    for (const from of all) {
      for (const to of all) {
        expect(isValidTransition(from, to)).toBe(allowed[from].includes(to));
      }
    }
  });

  /** Leva uma BET ao status pedido usando só a API pública. */
  function inStatus(status: Status): WagerTransaction {
    const tx = make({
      kind: Kind.Refund,
      referenceExternalTransactionId: 'bet-x',
    });
    switch (status) {
      case Status.Pending:
        break;
      case Status.PendingReference:
        tx.markPendingReference();
        break;
      case Status.Processed:
        tx.markProcessed('internal-ref', t1);
        break;
      case Status.Rejected:
        tx.reject(FailureCode.ReferenceNotFound);
        break;
      case Status.Failed:
        tx.fail(FailureCode.PermanentInfrastructureError);
        break;
    }
    return tx;
  }

  const apply: Record<Status, (tx: WagerTransaction) => void> = {
    [Status.Pending]: () => {
      throw new Error('PENDING não é destino de nenhuma transição');
    },
    [Status.PendingReference]: (tx) => tx.markPendingReference(),
    [Status.Processed]: (tx) => tx.markProcessed('internal-ref', t1),
    [Status.Rejected]: (tx) => tx.reject(FailureCode.ReferenceNotFound),
    [Status.Failed]: (tx) => tx.fail(FailureCode.PermanentInfrastructureError),
  };

  for (const from of all) {
    for (const to of all.filter((s) => s !== Status.Pending)) {
      const valid = allowed[from].includes(to);
      it(`${from} -> ${to} ${valid ? 'é permitida' : 'lança InvalidTransactionStateError'}`, () => {
        const tx = inStatus(from);
        if (valid) {
          apply[to](tx);
          expect(tx.status).toBe(to);
        } else {
          expect(() => apply[to](tx)).toThrow(InvalidTransactionStateError);
          expect(tx.status).toBe(from); // estado intacto após a falha
        }
      });
    }
  }

  it('terminais continuam terminais e isTerminal() reflete isso', () => {
    expect(inStatus(Status.Pending).isTerminal()).toBe(false);
    expect(inStatus(Status.PendingReference).isTerminal()).toBe(false);
    expect(inStatus(Status.Processed).isTerminal()).toBe(true);
    expect(inStatus(Status.Rejected).isTerminal()).toBe(true);
    expect(inStatus(Status.Failed).isTerminal()).toBe(true);
  });
});

describe('transições: efeitos e validações', () => {
  it('markProcessed grava processedAt e a referência resolvida', () => {
    const tx = make({ kind: Kind.Refund, referenceExternalTransactionId: 'b' });
    tx.markProcessed('internal-bet-id', t1);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(t1);
    expect(tx.referenceTransactionId).toBe('internal-bet-id');
    expect(tx.failureCode).toBeUndefined();
  });

  it('REFUND e ROLLBACK não podem ser processados sem a referência resolvida', () => {
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      const tx = make({ kind, referenceExternalTransactionId: 'b' });
      expect(() => tx.markProcessed(undefined, t1)).toThrow(
        InvalidTransactionError,
      );
      expect(tx.status).toBe(Status.Pending);
    }
  });

  it('BET não aceita referência resolvida; WIN aceita com ou sem', () => {
    expect(() => bet().markProcessed('x', t1)).toThrow(InvalidTransactionError);
    expect(() => bet().markProcessed(undefined, t1)).not.toThrow();
    expect(() =>
      make({ kind: Kind.Win }).markProcessed(undefined, t1),
    ).not.toThrow();
    expect(() => make({ kind: Kind.Win }).markProcessed('x', t1)).not.toThrow();
  });

  it('markPendingReference só vale para quem tem referência', () => {
    expect(() => bet().markPendingReference()).toThrow(InvalidTransactionError);
    expect(() =>
      make({
        kind: Kind.Rollback,
        referenceExternalTransactionId: 'b',
      }).markPendingReference(),
    ).not.toThrow();
  });

  it('reject grava o failureCode e exige código de negócio', () => {
    const tx = bet();
    expect(() => tx.reject(FailureCode.PermanentInfrastructureError)).toThrow(
      InvalidTransactionError,
    );
    expect(tx.status).toBe(Status.Pending);
    tx.reject(FailureCode.InsufficientFunds);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.processedAt).toBeUndefined();
  });

  it('fail grava o failureCode e exige código de infraestrutura', () => {
    const tx = bet();
    expect(() => tx.fail(FailureCode.InsufficientFunds)).toThrow(
      InvalidTransactionError,
    );
    tx.fail(FailureCode.PermanentInfrastructureError);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(FailureCode.PermanentInfrastructureError);
  });
});

describe('consultas de domínio', () => {
  it('affectsBalance é false só para LOSS', () => {
    expect(make({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(make({ kind }).affectsBalance()).toBe(true);
    }
    for (const kind of [Kind.Refund, Kind.Rollback]) {
      expect(
        make({ kind, referenceExternalTransactionId: 'b' }).affectsBalance(),
      ).toBe(true);
    }
  });

  it('requiresReference é true só para REFUND e ROLLBACK', () => {
    expect(bet().requiresReference()).toBe(false);
    expect(make({ kind: Kind.Win }).requiresReference()).toBe(false);
    expect(make({ kind: Kind.Loss }).requiresReference()).toBe(false);
    expect(
      make({
        kind: Kind.Refund,
        referenceExternalTransactionId: 'b',
      }).requiresReference(),
    ).toBe(true);
    expect(
      make({
        kind: Kind.Rollback,
        referenceExternalTransactionId: 'b',
      }).requiresReference(),
    ).toBe(true);
  });

  it('matchesPayload: mesma key com payload diferente é detectável', () => {
    const original = make({
      externalTransactionId: 'same',
      money: brl('25.00'),
    });
    const same = make({ externalTransactionId: 'same', money: brl('25.00') });
    const different = make({
      externalTransactionId: 'same',
      money: brl('26.00'),
    });
    expect(original.matchesPayload(same.payloadHash)).toBe(true);
    expect(original.matchesPayload(different.payloadHash)).toBe(false);
  });

  it('o hash ignora o header de idempotência e o instante de criação', () => {
    const a = make({
      externalTransactionId: 'same',
      idempotencyKey: 'key-a',
      now: t0,
    });
    const b = make({
      externalTransactionId: 'same',
      idempotencyKey: 'key-b',
      now: t1,
    });
    expect(a.payloadHash).toBe(b.payloadHash);
  });
});

describe('ledgerDirectionFor', () => {
  it('BET debita; WIN e REFUND creditam', () => {
    expect(bet().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: Kind.Win }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(
      make({
        kind: Kind.Refund,
        referenceExternalTransactionId: 'b',
      }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  it('LOSS não gera lançamento', () => {
    expect(() => make({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidTransactionError,
    );
  });

  it('ROLLBACK é o inverso da referência (BET, WIN ou REFUND)', () => {
    const rollback = make({
      kind: Kind.Rollback,
      referenceExternalTransactionId: 'r',
    });
    const refund = make({
      kind: Kind.Refund,
      referenceExternalTransactionId: 'b',
    });
    expect(rollback.ledgerDirectionFor(bet())).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(make({ kind: Kind.Win }))).toBe(
      LedgerDirection.Debit,
    );
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK exige referência e não reverte LOSS nem outro ROLLBACK', () => {
    const rollback = make({
      kind: Kind.Rollback,
      referenceExternalTransactionId: 'r',
    });
    expect(() => rollback.ledgerDirectionFor()).toThrow(
      InvalidTransactionError,
    );
    expect(() =>
      rollback.ledgerDirectionFor(make({ kind: Kind.Loss })),
    ).toThrow(InvalidTransactionError);
    expect(() =>
      rollback.ledgerDirectionFor(
        make({ kind: Kind.Rollback, referenceExternalTransactionId: 'x' }),
      ),
    ).toThrow(InvalidTransactionError);
  });
});

describe('checkReference', () => {
  const refundOf = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
    make({
      kind: Kind.Refund,
      referenceExternalTransactionId: 'bet-1',
      money: brl('25.00'),
      ...overrides,
    });

  it('aceita referência compatível', () => {
    expect(refundOf().checkReference(bet('bet-1', '25.00'))).toBeUndefined();
  });

  it('transação sem referência não tem o que checar', () => {
    expect(bet().checkReference(bet('other'))).toBeUndefined();
  });

  it('REFERENCE_MISMATCH para provider, player, wallet, rodada ou moeda diferentes', () => {
    const refund = refundOf();
    const mismatches: Partial<CreateWagerTransactionProps>[] = [
      { providerId: 'provider-b' },
      { playerId: 'player-2' },
      { walletId: 'wallet-2' },
      { roundId: 'round-2' },
      { money: Money.from({ amount: '25.00', currency: 'USD' }) },
    ];
    for (const override of mismatches) {
      const reference = make({
        externalTransactionId: 'bet-1',
        kind: Kind.Bet,
        ...override,
      });
      expect(refund.checkReference(reference)).toBe(
        FailureCode.ReferenceMismatch,
      );
    }
  });

  it('REFERENCE_MISMATCH se o externalTransactionId da referência não confere', () => {
    expect(refundOf().checkReference(bet('another-id'))).toBe(
      FailureCode.ReferenceMismatch,
    );
  });

  it('REFUND só referencia BET', () => {
    const refund = refundOf();
    const win = make({ externalTransactionId: 'bet-1', kind: Kind.Win });
    expect(refund.checkReference(win)).toBe(FailureCode.InvalidReferenceKind);
  });

  it('ROLLBACK referencia BET, WIN ou REFUND, e nada além disso', () => {
    const rollback = make({
      kind: Kind.Rollback,
      referenceExternalTransactionId: 'ref-1',
      money: brl('25.00'),
    });
    for (const kind of [Kind.Bet, Kind.Win]) {
      expect(
        rollback.checkReference(make({ externalTransactionId: 'ref-1', kind })),
      ).toBeUndefined();
    }
    expect(
      rollback.checkReference(
        make({
          externalTransactionId: 'ref-1',
          kind: Kind.Refund,
          referenceExternalTransactionId: 'bet-1',
        }),
      ),
    ).toBeUndefined();
    expect(
      rollback.checkReference(
        make({ externalTransactionId: 'ref-1', kind: Kind.Loss }),
      ),
    ).toBe(FailureCode.InvalidReferenceKind);
    expect(
      rollback.checkReference(
        make({
          externalTransactionId: 'ref-1',
          kind: Kind.Rollback,
          referenceExternalTransactionId: 'x',
        }),
      ),
    ).toBe(FailureCode.InvalidReferenceKind);
  });

  it('AMOUNT_MISMATCH quando o valor da reversão difere do da referência', () => {
    expect(
      refundOf({ money: brl('24.99') }).checkReference(bet('bet-1', '25.00')),
    ).toBe(FailureCode.AmountMismatch);
  });

  it('WIN com referência não exige valor igual (só reversões exigem)', () => {
    const win = make({
      kind: Kind.Win,
      referenceExternalTransactionId: 'bet-1',
      money: brl('80.00'),
    });
    expect(win.checkReference(bet('bet-1', '25.00'))).toBeUndefined();
  });

  it('WIN que referencia algo que não é BET é rejeitado', () => {
    const win = make({ kind: Kind.Win, referenceExternalTransactionId: 'x' });
    const reference = make({ externalTransactionId: 'x', kind: Kind.Win });
    expect(win.checkReference(reference)).toBe(
      FailureCode.InvalidReferenceKind,
    );
  });
});

describe('WagerTransaction.rehydrate', () => {
  it('reconstrói o estado persistido sem revalidar transições', () => {
    const tx = WagerTransaction.rehydrate({
      id: 'id-9',
      providerId: 'provider-a',
      externalTransactionId: 'ext-9',
      idempotencyKey: 'provider-a:ext-9',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: Kind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
      createdAt: t0,
      status: Status.Rejected,
      failureCode: FailureCode.AmountMismatch,
    });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.AmountMismatch);
    expect(tx.money.toString()).toBe('25.00');
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.markProcessed('x', t1)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('módulo wagering: guarda contra number/float', () => {
  it('nenhum arquivo de produção usa number para valores nem parseFloat/Number()', () => {
    for (const file of ['wager-transaction.ts', 'payload-hash.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(source).not.toMatch(/:\s*number\b/);
      expect(source).not.toMatch(/\bparseFloat\b/);
      expect(source).not.toMatch(/\bNumber\s*\(/);
    }
  });
});
