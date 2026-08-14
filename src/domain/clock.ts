export interface Clock {
  now(): number;
  advance(ms: number): void;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  advance(_ms: number): void {
    throw new Error("SystemClock cannot be advanced.");
  }
}

export class FakeClock implements Clock {
  constructor(private millis: number = 1_700_000_000_000) {}

  now(): number {
    return this.millis;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error("FakeClock.advance requires a non-negative finite duration.");
    }
    this.millis += ms;
  }

  set(millis: number): void {
    this.millis = millis;
  }
}

export class SequentialIds {
  private n = 0;
  constructor(private readonly prefix = "id") {}

  next(kind = this.prefix): string {
    this.n += 1;
    return `${kind}-${String(this.n).padStart(4, "0")}`;
  }
}
