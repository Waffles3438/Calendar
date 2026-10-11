import { describe, expect, it, vi } from "vitest";

import { OwnerCommandRouter } from "../src/application/owner-command-router.js";
import type { CalendarReference } from "../src/domain/calendar.js";
import type { NaturalLanguageDomainClassifier } from "../src/nlp/natural-language-domain-classifier.js";
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

  it("reports Google as unconfigured when no Calendar integration is wired", async () => {
    const router = new OwnerCommandRouter({
      ownerId: "123456789012345678",
      stateRepository: {},
    });
    const input = message("status");

    await router.handle(input);

    expect(input.replies).toEqual(["Google Calendar is not configured."]);
  });

  it("reports a disconnected Google account when no credential is stored", async () => {
    const router = new OwnerCommandRouter({
      calendarReader: { listCalendars: async (): Promise<readonly CalendarReference[]> => [] },
      oauthService: { beginAuthorization: () => ({ authorizationUrl: "unused", state: "unused" }) },
      ownerId: "123456789012345678",
      stateRepository: { getGoogleOAuth: vi.fn(() => undefined) },
    });
    const input = message("status");

    await router.handle(input);

    expect(input.replies).toEqual(["Google Calendar is not connected. Send /connect to link it."]);
  });

  it("reports a connected account without a primary calendar safely", async () => {
    const router = new OwnerCommandRouter({
      calendarReader: { listCalendars: async (): Promise<readonly CalendarReference[]> => [] },
      oauthService: { beginAuthorization: () => ({ authorizationUrl: "unused", state: "unused" }) },
      ownerId: "123456789012345678",
      stateRepository: { getGoogleOAuth: vi.fn(() => ({ accessToken: "token", refreshToken: "refresh" })) },
    });
    const input = message("status");

    await router.handle(input);

    expect(input.replies).toEqual(["Google Calendar is connected, but no primary calendar was available."]);
  });

  it("reports a safe status when the Calendar read fails", async () => {
    const router = new OwnerCommandRouter({
      calendarReader: {
        listCalendars: async (): Promise<readonly CalendarReference[]> => {
          throw new Error("Google unavailable");
        }
      },
      oauthService: { beginAuthorization: () => ({ authorizationUrl: "unused", state: "unused" }) },
      ownerId: "123456789012345678",
      stateRepository: { getGoogleOAuth: vi.fn(() => ({ accessToken: "token", refreshToken: "refresh" })) },
    });
    const input = message("status");

    await router.handle(input);

    expect(input.replies).toEqual([
      "Google Calendar is linked, but I could not read its current status. Try /connect again if this persists.",
    ]);
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

  it("returns a safe status when stored Google credentials cannot be read", async () => {
    const router = new OwnerCommandRouter({
      calendarReader: { listCalendars: async (): Promise<readonly CalendarReference[]> => [] },
      oauthService: { beginAuthorization: () => ({ authorizationUrl: "unused", state: "unused" }) },
      ownerId: "123456789012345678",
      stateRepository: {
        getGoogleOAuth: () => {
          throw new Error("Stored Google OAuth credentials are invalid");
        },
      },
    });
    const input = message("status");

    await router.handle(input);

    expect(input.replies).toEqual([
      expect.stringContaining("I could not read its current status"),
    ]);
  });

  it("notifies Calendar-dependent caches after a successful disconnect", async () => {
    const clearGoogleOAuth = vi.fn();
    const onCalendarStateChanged = vi.fn();
    const router = new OwnerCommandRouter({
      onCalendarStateChanged,
      oauthService: { beginAuthorization: () => ({ authorizationUrl: "unused", state: "unused" }) },
      ownerId: "123456789012345678",
      stateRepository: { clearGoogleOAuth },
    });
    const input = message("/disconnect");

    await router.handle(input);

    expect(clearGoogleOAuth).toHaveBeenCalledTimes(1);
    expect(onCalendarStateChanged).toHaveBeenCalledTimes(1);
    expect(input.replies).toEqual(["Google Calendar has been disconnected from this bot."]);
  });
});


describe("OwnerCommandRouter natural-language routing", () => {
  it("uses the classifier-selected natural task entry point and labels its reply by default", async () => {
    const calls: string[] = [];
    const classifier = {
      classify: async () => ({ domain: "task" as const }),
    } satisfies NaturalLanguageDomainClassifier;
    const router = new OwnerCommandRouter({
      localTaskAssistant: {
        canHandlePendingAction: () => false,
        handle: async () => {
          calls.push("deterministic");
        },
        handleNaturalLanguage: async (routedMessage: OwnerDirectMessage) => {
          calls.push("natural");
          await routedMessage.reply("Handled as a natural task.");
        },
        handlePendingAction: async () => false,
        isTaskInput: () => false,
      },
      naturalLanguageClassifier: classifier,
      ownerId: "123456789012345678",
      stateRepository: {},
      taskTimeZone: "America/Toronto",
    });
    const input = message("I need to remember to call the plumber tomorrow.");

    await router.handle(input);

    expect(calls).toEqual(["natural"]);
    expect(input.replies).toEqual(["Handled as a natural task. [Gemini]"]);
  });

  it("labels a Gemini classifier clarification by default", async () => {
    const router = new OwnerCommandRouter({
      naturalLanguageClassifier: {
        classify: async () => ({ kind: "clarify" as const, reason: "missing_required_detail" as const }),
      },
      ownerId: "123456789012345678",
      stateRepository: {},
    });
    const input = message("Please handle the thing.");

    await router.handle(input);

    expect(input.replies).toEqual([
      "I need a little more detail before I can do that. Please include the missing date, time, title, or task description. [Gemini]",
    ]);
  });

  it("does not label an accepted Gemini classifier result when disabled", async () => {
    const router = new OwnerCommandRouter({
      geminiResponseLabelEnabled: false,
      naturalLanguageClassifier: {
        classify: async () => ({ kind: "clarify" as const, reason: "ambiguous_domain" as const }),
      },
      ownerId: "123456789012345678",
      stateRepository: {},
    });
    const input = message("Please handle the thing.");

    await router.handle(input);

    expect(input.replies).toEqual([
      "Do you mean a Google Calendar event or a local task? Please say which one you want.",
    ]);
  });

  it("asks instead of routing when the classifier cannot decide", async () => {
    const router = new OwnerCommandRouter({
      naturalLanguageClassifier: {
        classify: async () => undefined,
      },
      ownerId: "123456789012345678",
      stateRepository: {},
    });
    const input = message("Please handle the thing.");

    await router.handle(input);

    expect(input.replies).toEqual([
      "I could not determine whether that is a Calendar request or a local task. Please be more specific.",
    ]);
  });
});


describe("OwnerCommandRouter unavailable-classifier fallback", () => {
  it("falls through to Calendar when the classifier cannot decide without a Gemini label", async () => {
    const calendarHandle = vi.fn(async (routedMessage: OwnerDirectMessage): Promise<void> => {
      await routedMessage.reply("Calendar fallback reply.");
    });
    const router = new OwnerCommandRouter({
      calendarAssistant: { handle: calendarHandle },
      naturalLanguageClassifier: { classify: async () => undefined },
      ownerId: "123456789012345678",
      stateRepository: {},
    });
    const input = message("Please handle the Calendar thing.");

    await router.handle(input);

    expect(calendarHandle).toHaveBeenCalledTimes(1);
    expect(calendarHandle).toHaveBeenCalledWith(expect.objectContaining({
      authorId: input.authorId,
      content: input.content,
      id: input.id,
    }));
    expect(input.replies).toEqual(["Calendar fallback reply."]);
  });

  it("does not label a fallback response when the classifier throws", async () => {
    const router = new OwnerCommandRouter({
      naturalLanguageClassifier: {
        classify: async () => {
          throw new Error("Gemini is unavailable");
        },
      },
      ownerId: "123456789012345678",
      stateRepository: {},
    });
    const input = message("Please handle the thing.");

    await router.handle(input);

    expect(input.replies).toEqual([
      "I could not determine whether that is a Calendar request or a local task. Please be more specific.",
    ]);
  });
});
