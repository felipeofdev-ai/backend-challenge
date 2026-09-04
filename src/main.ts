import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { logger } from "./infrastructure/observability/logger";
import { startOtelIfConfigured } from "./infrastructure/observability/otel-bootstrap";
import { applyDatabaseEnv, loadConfig } from "./shared/config";

async function bootstrap(): Promise<void> {
  await startOtelIfConfigured();
  const config = loadConfig();
  applyDatabaseEnv(config);

  const app = await NestFactory.create(AppModule, {
    logger: false,
  });

  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle("Wagering Processor")
    .setDescription(
      "Distributed wagering API — Jungle Gaming challenge. Health endpoints are public; business routes use AUTH_MODE.",
    )
    .setVersion("1.0.0")
    .addApiKey({ type: "apiKey", name: "Idempotency-Key", in: "header" }, "Idempotency-Key")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swagger));

  await app.listen(config.port);
  logger.info({
    msg: "api_started",
    port: config.port,
    persistence: config.persistence,
    authMode: config.authMode,
    docs: `http://localhost:${config.port}/docs`,
  });
}

bootstrap().catch((err: unknown) => {
  logger.error({ msg: "api_boot_failed", error: String(err) });
  process.exit(1);
});
