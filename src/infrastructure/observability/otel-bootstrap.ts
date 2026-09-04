/**
 * Optional OpenTelemetry OTLP export (challenge §12 — optional).
 * Enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set; default remains no-op API spans.
 */
import { logger } from "./logger";

let started = false;

export async function startOtelIfConfigured(): Promise<void> {
  if (started) return;
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (!endpoint) return;

  started = true;
  try {
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions");
    const { NodeTracerProvider, BatchSpanProcessor } = await import(
      "@opentelemetry/sdk-trace-node"
    );
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");

    const serviceName =
      process.env["OTEL_SERVICE_NAME"] ?? process.env["APP_NAME"] ?? "wagering-processor";
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: endpoint.includes("/v1/traces")
              ? endpoint
              : `${endpoint.replace(/\/$/, "")}/v1/traces`,
          }),
        ),
      ],
    });
    provider.register();
    logger.info({ msg: "otel_otlp_started", endpoint, serviceName });
  } catch (err) {
    logger.warn({ msg: "otel_otlp_start_failed", error: String(err) });
  }
}
