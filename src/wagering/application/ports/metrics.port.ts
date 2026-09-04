/**
 * Application-facing metrics (keeps Prometheus out of use-case imports).
 */
export interface ProcessMetricsPort {
  recordLockConflict(): void;
  recordIdempotentReplay(source: string): void;
}

export class NoopProcessMetrics implements ProcessMetricsPort {
  recordLockConflict(): void {}
  recordIdempotentReplay(_source: string): void {}
}
