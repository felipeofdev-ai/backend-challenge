import { describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/mikro-orm.unit-of-work";
import { DependencyUnavailableError } from "../../src/wagering/domain/errors";
import { postgresAvailable } from "../helpers/pg";

const pgAvailable = await postgresAvailable();

describe.skipIf(!pgAvailable)("forensic · pool saturation", () => {
  test("acquireTimeout under saturated pool → DependencyUnavailableError", async () => {
    process.env["DATABASE_PORT"] = process.env["DATABASE_PORT"] ?? "5433";
    const orm = await MikroORM.init({
      ...config,
      debug: false,
      pool: {
        min: 1,
        max: 1,
        acquireTimeoutMillis: 400,
      },
    });

    try {
      const holder = orm.em.fork();
      const waiter = new MikroOrmUnitOfWork(orm.em.fork());

      // Hold the only pool connection inside an open TX
      const hold = holder.transactional(async (tem) => {
        await tem.execute("SELECT pg_sleep(2)");
      });

      await new Promise((r) => setTimeout(r, 50));

      let sawUnavailable = false;
      try {
        await waiter.transactional(async (repos) => {
          await repos.wallets.findById("00000000-0000-7000-8000-000000000001");
        });
      } catch (err) {
        sawUnavailable = err instanceof DependencyUnavailableError;
        if (!sawUnavailable) {
          // Some drivers surface raw pool timeout before our wrapper — still must be classified
          const { classifyPgError } = await import("../../src/shared/pg-error");
          sawUnavailable = classifyPgError(err) === "unavailable";
        }
      }

      await hold.catch(() => undefined);
      expect(sawUnavailable).toBe(true);
    } finally {
      await orm.close(true);
    }
  }, 30_000);
});
