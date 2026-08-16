import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";

describe("createLogger", () => {
  it("redacts configured secrets from structured logs", async () => {
    const destination = new PassThrough();
    const chunks: Buffer[] = [];
    destination.on("data", (chunk: Buffer) => chunks.push(chunk));

    const logger = createLogger("info", destination);
    logger.info(
      {
        DISCORD_BOT_TOKEN: "discord-secret",
        session: { refreshToken: "refresh-secret" },
      },
      "test log",
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    const output = Buffer.concat(chunks).toString("utf8");

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("discord-secret");
    expect(output).not.toContain("refresh-secret");
  });
});
