/**
 * Conversão estrita das linhas do banco para o domínio.
 *
 * O driver pode devolver tipos inesperados (um `numeric` como `number`
 * perderia precisão em silêncio). Em vez de confiar, cada coluna é validada
 * e qualquer divergência vira erro explícito.
 */
export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersistenceError';
  }
}

export type Row = Record<string, unknown>;

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new PersistenceError(
      `column ${column}: expected text, got ${describe(value)}`,
    );
  }
  return value;
}

export function optionalText(row: Row, column: string): string | undefined {
  return row[column] === null || row[column] === undefined
    ? undefined
    : text(row, column);
}

/** `numeric(19,2)` precisa chegar como string decimal com 2 casas. */
export function amount(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || !/^\d{1,17}\.\d{2}$/.test(value)) {
    throw new PersistenceError(
      `column ${column}: expected a numeric(19,2) decimal string, got ${describe(value)}`,
    );
  }
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new PersistenceError(
      `column ${column}: expected an integer, got ${describe(value)}`,
    );
  }
  return parsed;
}

export function timestamp(row: Row, column: string): Date {
  const value = row[column];
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string'
        ? new Date(value)
        : new Date(NaN);
  if (Number.isNaN(date.getTime())) {
    throw new PersistenceError(
      `column ${column}: expected a timestamp, got ${describe(value)}`,
    );
  }
  return date;
}

export function optionalTimestamp(row: Row, column: string): Date | undefined {
  return row[column] === null || row[column] === undefined
    ? undefined
    : timestamp(row, column);
}

export function enumValue<E extends string>(
  allowed: Readonly<Record<string, E>>,
  row: Row,
  column: string,
): E {
  const value = text(row, column);
  const match = Object.values(allowed).find((candidate) => candidate === value);
  if (match === undefined) {
    throw new PersistenceError(
      `column ${column}: unexpected value ${JSON.stringify(value)}`,
    );
  }
  return match;
}

export function optionalEnumValue<E extends string>(
  allowed: Readonly<Record<string, E>>,
  row: Row,
  column: string,
): E | undefined {
  return row[column] === null || row[column] === undefined
    ? undefined
    : enumValue(allowed, row, column);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return `${typeof value} ${String(value)}`;
  }
  return typeof value;
}
