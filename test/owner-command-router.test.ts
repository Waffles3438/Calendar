import { describe, expect, it, vi } from "vitest";

import { OwnerCommandRouter } from "../src/application/owner-command-router.js";
import type { CalendarReference } from "../src/domain/calendar.js";
import type { OwnerDirectMessage } from "../src/discord/owner-dm-handler.js";

function message(content: string): OwnerDirectMessage & { replies: string[] } {
  const replies: string[] = [];
  return {
    authorId: "123456789012345678",
    content,
    id: "message-1",
    replies,
    reply: async (response) => {
      replies.push(response);
    },
  };
}

describe("OwnerCommandRouter", () => {
  it("starts the OAuth flow only for the configured owner command", async () => {
    const beginAuthorization = vi.fn(() => ({
      authorizationUrl: "https://accounts.example.test/auth",
      state: "state-1",
    }));
    const router = new OwnerCommandRouter({
      calendarReader: { listCalendars: async (): Promise<readonly CalendarReference[]> => [] },
      oauthService: { beginAuthorization },
      ownerId: "123456789012345678",
      stateRepository: {
        clearGoogleOAuth: vi.fn(),
        getGoogleOAuth: vi.fn(() => undefined),
      },
    });
    const input = message("/connect");

    await router.handle(input);

    expect(beginAuthorization).toHaveBeenCalledWith("123456789012345678");
    expect(input.replies).toEqual([expect.stringContaining("https://accounts.example.test/auth")]);
  });

  it("reports the connected primary calendar through the status command", async () => {
    const router = new OwnerCommandRouter({
      calendarReader: {
        listCalendars: async (): Promise<readonly CalendarReference[]> => [
          {
            id: "primary",
            isPrimary: true,
            readOnly: false,
            summary: "Personal",
            timeZone: "America/Chicago",
          },
        ],
      },
      oauthService: { beginAuthorization: () => ({ authorizationUrl: "unused", state: "unused" }) },
      ownerId: "123456789012345678",
      stateRepository: {
        clearGoogleOAuth: vi.fn(),
        getGoogleOAuth: vi.fn(() => ({ accessToken: "token", refreshToken: "refresh" })),
      },
    });
    const input = message("status");

    await router.handle(input);

    expect(input.replies).toEqual([expect.stringContaining("America/Chicago")]);
  });
});
