import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../../application/ports/runtime';

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
