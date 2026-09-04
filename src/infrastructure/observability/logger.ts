import pino from "pino";

const level = process.env["LOG_LEVEL"] ?? "info";

/** Structured JSON logger (pino). Correlation fields are caller-owned. */
export const logger = pino({
  level,
  base: {
    service: process.env["APP_NAME"] ?? "wagering-processor",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
      "password",
      "accessToken",
      "refreshToken",
      "client_secret",
    ],
    remove: true,
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export type Logger = typeof logger;
