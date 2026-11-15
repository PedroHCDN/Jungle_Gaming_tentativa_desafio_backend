import type { Clock } from '../../application/ports/runtime';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
