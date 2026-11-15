import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  nextAttemptAt,
} from './pending-reference-policy';

const now = new Date('2026-01-01T00:00:00.000Z');
const delays = (policy = DEFAULT_PENDING_REFERENCE_POLICY) =>
  Array.from({ length: policy.maxAttempts }, (_, index) => {
    const next = nextAttemptAt(policy, index + 1, now);
    return next === undefined ? undefined : next.getTime() - now.getTime();
  });

describe('nextAttemptAt (backoff exponencial)', () => {
  it('padrão: espera 1 s, 2 s, 4 s e 8 s e desiste na 5ª falha', () => {
    expect(delays()).toEqual([1000, 2000, 4000, 8000, undefined]);
  });

  it('respeita o atraso inicial e o limite configurados', () => {
    expect(delays({ maxAttempts: 3, initialDelayMs: 250 })).toEqual([
      250,
      500,
      undefined,
    ]);
  });

  it('com uma única tentativa nunca espera', () => {
    expect(delays({ maxAttempts: 1, initialDelayMs: 1000 })).toEqual([
      undefined,
    ]);
  });
});
