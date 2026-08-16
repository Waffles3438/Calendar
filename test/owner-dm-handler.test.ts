import { describe, expect, it } from "vitest";

import { createOwnerDmHandler } from "../src/discord/owner-dm-handler.js";
import { createLogger } from "../src/logger.js";

describe("owner DM handler", () => {
  it("passes only direct messages from the configured owner to the command handler", async () => {
    const received: string[] = [];
    const handle = createOwnerDmHandler({
      logger: createLogger("silent"),
      onOwnerMessage: async (message) => {
        received.push(message.content);
      },
      ownerId: "123456789012345678",
    });

    const reply = async (): Promise<void> => undefined;

    await expect(
      handle({
        authorId: "999999999999999999",
        content: "status",
        id: "message-1",
        isBot: false,
        isDirectMessage: true,
        reply,
      }),
    ).resolves.toBe(false);
    await expect(
      handle({
        authorId: "123456789012345678",
        content: "status",
        id: "message-2",
        isBot: true,
        isDirectMessage: true,
        reply,
      }),
    ).resolves.toBe(false);
    await expect(
      handle({
        authorId: "123456789012345678",
        content: "status",
        id: "message-3",
        isBot: false,
        isDirectMessage: false,
        reply,
      }),
    ).resolves.toBe(false);
    await expect(
      handle({
        authorId: "123456789012345678",
        content: "status",
        id: "message-4",
        isBot: false,
        isDirectMessage: true,
        reply,
      }),
    ).resolves.toBe(true);

    expect(received).toEqual(["status"]);
  });
});
