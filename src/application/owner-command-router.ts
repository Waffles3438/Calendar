import type { CalendarMessageHandler } from "./calendar-assistant.js";
import {
  parsePendingActionInstruction,
  pendingActionInvalidMessage,
  type PendingActionMessageHandler,
} from "./pending-action.js";
import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";
import type { CalendarReader } from "../google/calendar-api.js";
import type { GoogleAuthorizationRequest } from "../google/oauth-service.js";
import type { GoogleOAuthCredentials, PendingAction } from "../persistence/state-repository.js";

interface RoutedMessageHandler extends CalendarMessageHandler, Partial<PendingActionMessageHandler> { }

interface LocalTaskMessageHandler extends PendingActionMessageHandler {
  handle(message: OwnerDirectMessage): Promise<void>;
  isTaskInput(content: string): boolean;
}

interface RouterStateRepository {
  clearGoogleOAuth?(): void;
  getGoogleOAuth?(): GoogleOAuthCredentials | undefined;
  getPendingAction?(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined;
}

export interface OwnerCommandRouterOptions {
  readonly calendarAssistant?: RoutedMessageHandler;
  readonly calendarReader?: CalendarReader;
  readonly localTaskAssistant?: LocalTaskMessageHandler;
  readonly oauthService?: {
    beginAuthorization(ownerId: string): GoogleAuthorizationRequest;
  };
  readonly ownerId: string;
  readonly stateRepository: RouterStateRepository;
  readonly taskTimeZone?: string;
}

/** Routes owner-only onboarding, shared pending actions, local tasks, then Calendar DMs. */
export class OwnerCommandRouter {
  public constructor(private readonly options: OwnerCommandRouterOptions) { }

  public async handle(message: OwnerDirectMessage): Promise<void> {
    const pendingInstruction = parsePendingActionInstruction(message.content);
    if (pendingInstruction) {
      await this.routePendingAction(message, pendingInstruction);
      return;
    }

    const command = message.content.trim().toLowerCase();

    if (command === "/connect" || command === "connect") {
      if (!this.options.oauthService) {
        await message.reply("Google Calendar integration is not configured for this bot.");
        return;
      }
      const authorization = this.options.oauthService.beginAuthorization(this.options.ownerId);
      await message.reply(
        `Open this secure Google authorization link, then return here: ${authorization.authorizationUrl}`,
      );
      return;
    }

    if (command === "/disconnect" || command === "disconnect") {
      if (!this.options.oauthService || !this.options.stateRepository.clearGoogleOAuth) {
        await message.reply("Google Calendar integration is not configured for this bot.");
        return;
      }
      this.options.stateRepository.clearGoogleOAuth();
      await message.reply("Google Calendar has been disconnected from this bot.");
      return;
    }

    if (command === "/status" || command === "status") {
      await this.replyWithStatus(message);
      return;
    }

    if (this.options.localTaskAssistant?.isTaskInput(message.content)) {
      await this.options.localTaskAssistant.handle(message);
      return;
    }

    if (this.options.calendarAssistant) {
      await this.options.calendarAssistant.handle(message);
      return;
    }

    if (this.options.localTaskAssistant) {
      await message.reply(
        "I can manage private local tasks. Try 'remind me at 6pm tomorrow to run' or 'tasks'. Google Calendar is not configured.",
      );
      return;
    }

    await message.reply(
      "I am your private calendar assistant. Send /connect to link Google Calendar, /status to check it, or /disconnect to remove access.",
    );
  }

  private async routePendingAction(
    message: OwnerDirectMessage,
    instruction: ReturnType<typeof parsePendingActionInstruction> extends infer Result
      ? Exclude<Result, undefined>
      : never,
  ): Promise<void> {
    const pending = this.options.stateRepository.getPendingAction?.({
      id: instruction.actionId,
      now: new Date(),
      ownerId: this.options.ownerId,
    });
    if (!pending) {
      await message.reply(pendingActionInvalidMessage(instruction.kind));
      return;
    }

    const handlers: readonly (PendingActionMessageHandler | undefined)[] = [
      this.options.localTaskAssistant,
      this.options.calendarAssistant &&
        typeof this.options.calendarAssistant.canHandlePendingAction === "function" &&
        typeof this.options.calendarAssistant.handlePendingAction === "function"
        ? this.options.calendarAssistant as PendingActionMessageHandler
        : undefined,
    ];
    for (const handler of handlers) {
      if (!handler?.canHandlePendingAction(pending.payload)) {
        continue;
      }
      if (await handler.handlePendingAction(message, instruction)) {
        return;
      }
    }

    await message.reply(pendingActionInvalidMessage(instruction.kind));
  }

  private async replyWithStatus(message: OwnerDirectMessage): Promise<void> {
    const status: string[] = [];
    if (this.options.localTaskAssistant) {
      status.push(`Local tasks are ready (${this.options.taskTimeZone ?? "America/Toronto"}).`);
    }

    if (!this.options.calendarReader || !this.options.oauthService || !this.options.stateRepository.getGoogleOAuth) {
      status.push("Google Calendar is not configured.");
      await message.reply(status.join(" "));
      return;
    }

    if (!this.options.stateRepository.getGoogleOAuth()) {
      status.push("Google Calendar is not connected. Send /connect to link it.");
      await message.reply(status.join(" "));
      return;
    }

    try {
      const calendars = await this.options.calendarReader.listCalendars();
      const primary = calendars.find((calendar) => calendar.isPrimary);
      if (!primary) {
        status.push("Google Calendar is connected, but no primary calendar was available.");
      } else {
        status.push(`Google Calendar is connected. Primary calendar: ${primary.summary} (${primary.timeZone}).`);
      }
    } catch {
      status.push(
        "Google Calendar is linked, but I could not read its current status. Try /connect again if this persists.",
      );
    }

    await message.reply(status.join(" "));
  }
}
