import type { CalendarMessageHandler } from "./calendar-assistant.js";
import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";
import type { CalendarReader } from "../google/calendar-api.js";
import type { GoogleAuthorizationRequest } from "../google/oauth-service.js";
import type { GoogleOAuthCredentials } from "../persistence/state-repository.js";

export interface OwnerCommandRouterOptions {
  readonly calendarAssistant?: CalendarMessageHandler;
  readonly calendarReader: CalendarReader;
  readonly oauthService: {
    beginAuthorization(ownerId: string): GoogleAuthorizationRequest;
  };
  readonly ownerId: string;
  readonly stateRepository: {
    clearGoogleOAuth(): void;
    getGoogleOAuth(): GoogleOAuthCredentials | undefined;
  };
}

/** Routes onboarding commands first, then delegates ordinary DMs to the calendar assistant. */
export class OwnerCommandRouter {
  public constructor(private readonly options: OwnerCommandRouterOptions) { }

  public async handle(message: OwnerDirectMessage): Promise<void> {
    const command = message.content.trim().toLowerCase();

    if (command === "/connect" || command === "connect") {
      const authorization = this.options.oauthService.beginAuthorization(this.options.ownerId);
      await message.reply(
        `Open this secure Google authorization link, then return here: ${authorization.authorizationUrl}`,
      );
      return;
    }

    if (command === "/disconnect" || command === "disconnect") {
      this.options.stateRepository.clearGoogleOAuth();
      await message.reply("Google Calendar has been disconnected from this bot.");
      return;
    }

    if (command === "/status" || command === "status") {
      await this.replyWithStatus(message);
      return;
    }

    if (this.options.calendarAssistant) {
      await this.options.calendarAssistant.handle(message);
      return;
    }

    await message.reply(
      "I am your private calendar assistant. Send /connect to link Google Calendar, /status to check it, or /disconnect to remove access.",
    );
  }

  private async replyWithStatus(message: OwnerDirectMessage): Promise<void> {
    if (!this.options.stateRepository.getGoogleOAuth()) {
      await message.reply("Google Calendar is not connected. Send /connect to link it.");
      return;
    }

    try {
      const calendars = await this.options.calendarReader.listCalendars();
      const primary = calendars.find((calendar) => calendar.isPrimary);
      if (!primary) {
        await message.reply("Google Calendar is connected, but no primary calendar was available.");
        return;
      }

      await message.reply(
        `Google Calendar is connected. Primary calendar: ${primary.summary} (${primary.timeZone}).`,
      );
    } catch {
      await message.reply(
        "Google Calendar is linked, but I could not read its current status. Try /connect again if this persists.",
      );
    }
  }
}
