import type { ProcessMetricsPort } from "../../wagering/application/ports/metrics.port";
import { idempotencyDuplicatesTotal, lockConflictsTotal } from "../observability/metrics";

export class PrometheusProcessMetrics implements ProcessMetricsPort {
  recordLockConflict(): void {
    lockConflictsTotal.inc();
  }

  recordIdempotentReplay(source: string): void {
    idempotencyDuplicatesTotal.inc({ source });
  }
}
