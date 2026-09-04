import { EntityManager } from "@mikro-orm/postgresql";
import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import { Optional } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { logger } from "../observability/logger";
import { dependencyProbeFailuresTotal } from "../observability/metrics";
import { SqsMessagingAdapter, createSqsClient, loadSqsConfigFromEnv } from "../sqs/sqs.adapter";

type CheckStatus = "ok" | "down" | "skipped";

@Controller("health")
export class HealthController {
  private readonly sqs: SqsMessagingAdapter | null;

  constructor(@Optional() private readonly em?: EntityManager) {
    try {
      const cfg = loadSqsConfigFromEnv();
      this.sqs = new SqsMessagingAdapter(
        createSqsClient(cfg),
        cfg.wagerQueueUrl,
        cfg.eventsQueueUrl,
      );
    } catch {
      this.sqs = null;
    }
  }

  @Public()
  @Get("live")
  @HttpCode(HttpStatus.OK)
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Public()
  @Get("ready")
  async ready(): Promise<{
    status: "ok" | "degraded";
    checks: Record<string, CheckStatus>;
  }> {
    const checks: Record<string, CheckStatus> = {
      postgres: "skipped",
      sqs: "skipped",
    };

    if (this.em) {
      try {
        await this.em.getConnection().execute("SELECT 1");
        checks.postgres = "ok";
      } catch (err) {
        checks.postgres = "down";
        dependencyProbeFailuresTotal.inc({ dependency: "postgres" });
        logger.warn({ err: String(err), msg: "health_postgres_down" });
      }
    } else if ((process.env["PERSISTENCE"] ?? "postgres").toLowerCase() === "memory") {
      checks.postgres = "skipped";
    } else {
      checks.postgres = "down";
      dependencyProbeFailuresTotal.inc({ dependency: "postgres" });
    }

    if (this.sqs) {
      const ok = await this.sqs.isReachable();
      checks.sqs = ok ? "ok" : "down";
      if (!ok) dependencyProbeFailuresTotal.inc({ dependency: "sqs" });
    }

    const requiredDown =
      (checks.postgres === "down" &&
        (process.env["PERSISTENCE"] ?? "postgres").toLowerCase() !== "memory") ||
      checks.sqs === "down";

    if (requiredDown) {
      throw new ServiceUnavailableException({
        status: "degraded",
        checks,
      });
    }

    return { status: "ok", checks };
  }
}
