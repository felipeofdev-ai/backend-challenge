/**
 * Lightweight OpenTelemetry-compatible tracing helpers.
 * Uses @opentelemetry/api so a real SDK exporter can be attached later without code changes.
 */
import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import { newId } from "../../shared/id";

const tracer = trace.getTracer("wagering-processor", "1.0.0");

export interface RequestCorrelation {
  traceId: string;
  spanId: string;
  correlationId: string;
}

export async function withWagerSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (correlation: RequestCorrelation) => Promise<T>,
): Promise<T> {
  const correlationId =
    typeof attributes["correlation.id"] === "string" ? attributes["correlation.id"] : newId();
  const span = tracer.startSpan(name, {
    attributes: { ...attributes, "correlation.id": correlationId },
  });
  const sc = span.spanContext();
  const correlation: RequestCorrelation = {
    traceId:
      sc.traceId && sc.traceId !== "00000000000000000000000000000000"
        ? sc.traceId
        : newId().replace(/-/g, ""),
    spanId:
      sc.spanId && sc.spanId !== "0000000000000000"
        ? sc.spanId
        : newId().replace(/-/g, "").slice(0, 16),
    correlationId,
  };

  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => fn(correlation));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof Error) span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}
