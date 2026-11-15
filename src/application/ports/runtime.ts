/** Relógio injetável: os testes controlam o tempo, produção usa o do sistema. */
export interface Clock {
  now(): Date;
}

/** Gerador de ids injetável (uuid v4 em produção). */
export interface IdGenerator {
  next(): string;
}
