import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { WalletNotFoundError } from "../../wagering/application/use-cases/process-wager.use-case";
import { DomainError, FailureCode } from "../../wagering/domain";

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    if (exception instanceof WalletNotFoundError) {
      res.status(HttpStatus.NOT_FOUND).json({
        error: {
          code: "WALLET_NOT_FOUND",
          message: exception.message,
          retryable: false,
          details: exception.details ?? {},
        },
      });
      return;
    }

    if (exception instanceof DomainError) {
      const status = mapStatus(exception.code, exception.details);
      res.status(status).json({
        error: {
          code:
            exception.details && typeof exception.details["code"] === "string"
              ? exception.details["code"]
              : exception.code,
          message: sanitizeClientMessage(exception.message),
          retryable: exception.retryable || status === HttpStatus.SERVICE_UNAVAILABLE,
          ...(exception.details !== undefined
            ? { details: sanitizeDetails(exception.details) }
            : {}),
        },
      });
      return;
    }

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal error",
        retryable: true,
      },
    });
  }
}

function sanitizeClientMessage(message: string): string {
  // Never echo raw SQL / driver internals to API clients
  if (/relation |syntax error|SQLSTATE|duplicate key value/i.test(message)) {
    return "Request could not be completed";
  }
  return message;
}

function sanitizeDetails(details: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === "string" && /SQLSTATE|relation |duplicate key/i.test(v)) continue;
    out[k] = v;
  }
  return out;
}

function mapStatus(code: FailureCode, details?: Readonly<Record<string, unknown>>): number {
  if (details && details["code"] === "TRANSACTION_NOT_FOUND") {
    return HttpStatus.NOT_FOUND;
  }
  if (details && details["code"] === "WALLET_NOT_FOUND") {
    return HttpStatus.NOT_FOUND;
  }

  switch (code) {
    case FailureCode.MISSING_IDEMPOTENCY_KEY:
    case FailureCode.INVALID_MONEY:
    case FailureCode.KIND_NOT_ALLOWED:
    case FailureCode.REFERENCE_REQUIRED:
    case FailureCode.REFERENCE_NOT_ALLOWED:
    case FailureCode.VALIDATION_ERROR:
      return HttpStatus.BAD_REQUEST;
    case FailureCode.IDEMPOTENCY_CONFLICT:
    case FailureCode.WALLET_ALREADY_EXISTS:
      return HttpStatus.CONFLICT;
    case FailureCode.INSUFFICIENT_BALANCE:
    case FailureCode.REFUND_WOULD_OVERDRAW:
    case FailureCode.ROLLBACK_WOULD_OVERDRAW:
    case FailureCode.REFERENCE_ALREADY_REVERSED:
    case FailureCode.REFERENCE_MISMATCH:
    case FailureCode.REFERENCE_AMOUNT_MISMATCH:
    case FailureCode.REFERENCE_INVALID_KIND:
    case FailureCode.WALLET_CURRENCY_MISMATCH:
    case FailureCode.REFERENCE_NOT_FOUND:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case FailureCode.DEPENDENCY_UNAVAILABLE:
    case FailureCode.LOCK_TIMEOUT:
      return HttpStatus.SERVICE_UNAVAILABLE;
    default:
      return HttpStatus.BAD_REQUEST;
  }
}
