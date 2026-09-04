/**
 * Typed application config — fail-fast on invalid production env.
 * Does not change financial rules; only validates/normalizes process.env.
 */

export type NodeEnv = "development" | "production" | "test";
export type AuthMode = "static" | "oidc";
export type PersistenceMode = "postgres" | "memory";

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly appName: string;
  readonly authMode: AuthMode;
  readonly allowAnonymous: boolean;
  readonly keycloak: {
    readonly issuer: string;
    readonly audience: string;
    readonly jwksUri: string;
  };
  readonly persistence: PersistenceMode;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly name: string;
    readonly ssl: boolean;
  };
  readonly aws: {
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly endpointUrl?: string;
  };
  readonly sqs: {
    readonly wagerQueueUrl: string;
    readonly wagerDlqUrl: string;
    readonly eventsQueueUrl: string;
    readonly eventsDlqUrl: string;
  };
  readonly workers: {
    readonly outboxPollIntervalMs: number;
    readonly outboxClaimLeaseMs: number;
    readonly referencePollIntervalMs: number;
    readonly referenceMaxAttempts: number;
    readonly referenceTtlHours: number;
    readonly lockTimeoutMs: number;
    readonly lockRetryMax: number;
  };
  readonly logLevel: string;
  readonly metricsEnabled: boolean;
  /** sync = challenge §9 default; enqueue = opt-in 202→SQS (ADR-020) */
  readonly wagerHttpMode: "sync" | "enqueue";
  readonly otel: {
    readonly exporterEndpoint?: string;
    readonly serviceName: string;
  };
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function parseIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  }
  return n;
}

function parseBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

let cached: AppConfig | undefined;

export function loadConfig(options?: { forceReload?: boolean }): AppConfig {
  if (cached && !options?.forceReload) return cached;

  const nodeEnv = optional("NODE_ENV", "development") as NodeEnv;
  if (!["development", "production", "test"].includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV: ${nodeEnv}`);
  }

  const authMode = optional("AUTH_MODE", "static") as AuthMode;
  if (authMode !== "static" && authMode !== "oidc") {
    throw new Error(`Invalid AUTH_MODE: ${authMode}`);
  }

  const keycloakIssuer = optional("KEYCLOAK_ISSUER", "http://localhost:8080/realms/jungle-gaming");
  const keycloakAudience = optional("KEYCLOAK_AUDIENCE", "wagering-api");
  const keycloakJwksUri = optional(
    "KEYCLOAK_JWKS_URI",
    `${keycloakIssuer}/protocol/openid-connect/certs`,
  );

  const persistence = optional("PERSISTENCE", "postgres").toLowerCase() as PersistenceMode;
  if (persistence !== "postgres" && persistence !== "memory") {
    throw new Error(`Invalid PERSISTENCE: ${persistence}`);
  }
  if (persistence === "memory" && nodeEnv === "production") {
    throw new Error("PERSISTENCE=memory is a unit-test double only; refuse production boot");
  }

  const endpointUrl = process.env["AWS_ENDPOINT_URL"];
  const awsEndpoint = endpointUrl !== undefined && endpointUrl !== "" ? endpointUrl : undefined;

  const wagerHttpModeRaw = optional("WAGER_HTTP_MODE", "sync").toLowerCase();
  if (wagerHttpModeRaw !== "sync" && wagerHttpModeRaw !== "enqueue") {
    throw new Error(`Invalid WAGER_HTTP_MODE: ${wagerHttpModeRaw}`);
  }
  const wagerHttpMode = wagerHttpModeRaw as "sync" | "enqueue";

  const otelEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const otelExporter = otelEndpoint !== undefined && otelEndpoint !== "" ? otelEndpoint : undefined;

  const config: AppConfig = {
    nodeEnv,
    port: parseIntEnv("PORT", 3000),
    appName: optional("APP_NAME", "wagering-processor"),
    authMode,
    allowAnonymous: parseBool("ALLOW_ANONYMOUS", true),
    keycloak: {
      issuer: keycloakIssuer,
      audience: keycloakAudience,
      jwksUri: keycloakJwksUri,
    },
    persistence,
    database: {
      host: optional("DATABASE_HOST", "localhost"),
      port: parseIntEnv("DATABASE_PORT", 5433),
      user: optional("DATABASE_USER", "wagering"),
      password: optional("DATABASE_PASSWORD", "wagering"),
      name: optional("DATABASE_NAME", "wagering"),
      ssl: parseBool("DATABASE_SSL", false),
    },
    aws: {
      region: optional("AWS_REGION", "us-east-1"),
      accessKeyId: optional("AWS_ACCESS_KEY_ID", "test"),
      secretAccessKey: optional("AWS_SECRET_ACCESS_KEY", "test"),
      ...(awsEndpoint !== undefined ? { endpointUrl: awsEndpoint } : {}),
    },
    sqs: {
      wagerQueueUrl: optional(
        "SQS_WAGER_QUEUE_URL",
        "http://localhost:4566/000000000000/wager-transactions.fifo",
      ),
      wagerDlqUrl: optional(
        "SQS_WAGER_DLQ_URL",
        "http://localhost:4566/000000000000/wager-transactions-dlq.fifo",
      ),
      eventsQueueUrl: optional(
        "SQS_EVENTS_QUEUE_URL",
        "http://localhost:4566/000000000000/wager-events.fifo",
      ),
      eventsDlqUrl: optional(
        "SQS_EVENTS_DLQ_URL",
        "http://localhost:4566/000000000000/wager-events-dlq.fifo",
      ),
    },
    workers: {
      outboxPollIntervalMs: parseIntEnv("OUTBOX_POLL_INTERVAL_MS", 1000),
      outboxClaimLeaseMs: parseIntEnv("OUTBOX_CLAIM_LEASE_MS", 30_000),
      referencePollIntervalMs: parseIntEnv("REFERENCE_POLL_INTERVAL_MS", 15_000),
      referenceMaxAttempts: parseIntEnv("REFERENCE_MAX_ATTEMPTS", 10),
      referenceTtlHours: parseIntEnv("REFERENCE_TTL_HOURS", 24),
      lockTimeoutMs: parseIntEnv("LOCK_TIMEOUT_MS", 2000),
      lockRetryMax: parseIntEnv("LOCK_RETRY_MAX", 3),
    },
    logLevel: optional("LOG_LEVEL", nodeEnv === "production" ? "info" : "debug"),
    metricsEnabled: parseBool("METRICS_ENABLED", true),
    wagerHttpMode,
    otel: {
      ...(otelExporter !== undefined ? { exporterEndpoint: otelExporter } : {}),
      serviceName: optional("OTEL_SERVICE_NAME", optional("APP_NAME", "wagering-processor")),
    },
  };

  if (config.port < 1 || config.port > 65535) {
    throw new Error(`PORT out of range: ${config.port}`);
  }

  cached = config;
  return config;
}

/** Apply DATABASE_* from config into process.env for MikroORM config readers. */
export function applyDatabaseEnv(config: AppConfig = loadConfig()): void {
  process.env["DATABASE_HOST"] = config.database.host;
  process.env["DATABASE_PORT"] = String(config.database.port);
  process.env["DATABASE_USER"] = config.database.user;
  process.env["DATABASE_PASSWORD"] = config.database.password;
  process.env["DATABASE_NAME"] = config.database.name;
  process.env["PERSISTENCE"] = config.persistence;
}
