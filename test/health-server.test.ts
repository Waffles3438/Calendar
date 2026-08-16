import { afterEach, describe, expect, it } from "vitest";

import { startHealthServer, type HealthServer } from "../src/http/health-server.js";
import { createLogger } from "../src/logger.js";

describe("health server", () => {
  let service: HealthServer | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it("returns healthy and ready responses", async () => {
    service = await startHealthServer({
      host: "127.0.0.1",
      logger: createLogger("silent"),
      port: 0,
    });

    const health = await fetch(`${service.url}/healthz`);
    const ready = await fetch(`${service.url}/readyz`);

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: "ready" });
  });

  it("reports an unready dependency without failing liveness", async () => {
    service = await startHealthServer({
      host: "127.0.0.1",
      isReady: () => false,
      logger: createLogger("silent"),
      port: 0,
    });

    const health = await fetch(`${service.url}/healthz`);
    const ready = await fetch(`${service.url}/readyz`);

    expect(health.status).toBe(200);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toEqual({ status: "not_ready" });
  });
});
