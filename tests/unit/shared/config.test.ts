import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../../src/shared/config";

describe("shared/config", () => {
  test("loads defaults with DATABASE_PORT override", () => {
    process.env["DATABASE_PORT"] = "5433";
    process.env["AUTH_MODE"] = "static";
    process.env["PERSISTENCE"] = "postgres";
    const cfg = loadConfig({ forceReload: true });
    expect(cfg.database.port).toBe(5433);
    expect(cfg.authMode).toBe("static");
    expect(cfg.persistence).toBe("postgres");
    expect(cfg.keycloak.audience).toBe("wagering-api");
    expect(cfg.wagerHttpMode).toBe("sync");
    expect(cfg.sqs.wagerQueueUrl).toContain("wager-transactions");
  });

  test("rejects invalid WAGER_HTTP_MODE", () => {
    process.env["AUTH_MODE"] = "static";
    process.env["WAGER_HTTP_MODE"] = "async-all";
    expect(() => loadConfig({ forceReload: true })).toThrow(/WAGER_HTTP_MODE/);
    process.env["WAGER_HTTP_MODE"] = "sync";
    loadConfig({ forceReload: true });
  });
  test("rejects invalid AUTH_MODE", () => {
    process.env["AUTH_MODE"] = "ldap";
    expect(() => loadConfig({ forceReload: true })).toThrow(/AUTH_MODE/);
    process.env["AUTH_MODE"] = "static";
    loadConfig({ forceReload: true });
  });
});
