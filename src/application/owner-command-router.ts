import type { CalendarMessageHandler } from "./calendar-assistant.js";
import type { CalendarManagementAssistant } from "./calendar-management-assistant.js";
import { markGeminiResponseUsed, withGeminiResponseAttribution } from "./gemini-response-attribution.js";
import {
  parsePendingActionInstruction,
  pendingActionInvalidMessage,
  type PendingActionMessageHandler,
} from "./pending-action.js";
import type { OwnerDirectMessage } from "../discord/owner-dm-handler.js";
import type { NaturalLanguageAction } from "../nlp/natural-language-action.js";
import type { NaturalLanguageActionPlanner } from "../nlp/natural-language-action-planner.js";
import type { CalendarReader } from "../google/calendar-api.js";
import type { GoogleAuthorizationRequest } from "../google/oauth-service.js";
import type { NaturalLanguageDomainClassifier } from "../nlp/natural-language-domain-classifier.js";
import type {
  NaturalLanguageClarificationReason,
  NaturalLanguageDomainDecision,
} from "../nlp/natural-language-types.js";
import type {
  GoogleOAuthCredentials,
  NaturalLanguageContextRecord,
  PendingAction,
} from "../persistence/state-repository.js";
import { isDeferredLegacyCalendarDelete } from "../scheduling/schedule-assistant.js";

interface RoutedMessageHandler extends CalendarMessageHandler, Partial<PendingActionMessageHandler> {
  handleNaturalLanguageAction?: (
    message: OwnerDirectMessage,
    action: Extract<NaturalLanguageAction, {
      action: "create_calendar_event" | "delete_calendar_event" | "list_calendar" |
      "manage_calendar_attendees" | "move_calendar_event" | "set_calendar_reminder";
    }>,
  ) => Promise<void>;
}

interface NamedDeleteMessageHandler extends PendingActionMessageHandler {
  handleNaturalLanguageAction(
    message: OwnerDirectMessage,
    action: Extract<NaturalLanguageAction, { action: "delete_task" }>,
  ): Promise<void>;
}

interface LocalTaskMessageHandler extends PendingActionMessageHandler {
  handle(message: OwnerDirectMessage): Promise<void>;
  handleNaturalLanguage(message: OwnerDirectMessage): Promise<void>;
  handleNaturalLanguageAction?: (
    message: OwnerDirectMessage,
    action: Extract<NaturalLanguageAction, {
      action: "complete_task" | "create_task_or_reminder" | "delete_task" | "list_tasks";
    }>,
  ) => Promise<void>;
  isTaskInput(content: string): boolean;
}

interface ScheduleMessageHandler extends PendingActionMessageHandler {
  handle(message: OwnerDirectMessage): Promise<boolean>;
  handleNaturalLanguageAction?: (
    message: OwnerDirectMessage,
    action: Extract<NaturalLanguageAction, {
      action: "cleanup_schedule" | "create_calendar_event" | "create_task_or_reminder" | "delete_task" | "show_agenda";
    }>,
  ) => Promise<boolean>;
}

interface RouterStateRepository {
  clearGoogleOAuth?(): void;
  clearNaturalLanguageContext?(input: { ownerId: string }): void;
  getGoogleOAuth?(): GoogleOAuthCredentials | undefined;
  getNaturalLanguageContext?(input: { now: Date; ownerId: string }): NaturalLanguageContextRecord | undefined;
  getPendingAction?(input: { id: string; now: Date; ownerId: string }): PendingAction | undefined;
  saveNaturalLanguageContext?(input: {
    clarificationQuestion: string;
    expiresAt: Date;
    now: Date;
    originalRequest: string;
    recentMessages: readonly string[];
    reason: NaturalLanguageClarificationReason;
    ownerId: string;
  }): void;
}

export interface OwnerCommandRouterOptions {
  readonly calendarAssistant?: RoutedMessageHandler;
  readonly calendarManagementAssistant?: CalendarManagementAssistant;
  readonly calendarReader?: CalendarReader;
  readonly geminiResponseLabelEnabled?: boolean;
  readonly localTaskAssistant?: LocalTaskMessageHandler;
  readonly namedDeleteHandler?: NamedDeleteMessageHandler;
  readonly naturalLanguageClassifier?: NaturalLanguageDomainClassifier;
  readonly naturalLanguagePlanner?: NaturalLanguageActionPlanner;
  readonly oauthService?: {
    beginAuthorization(ownerId: string): GoogleAuthorizationRequest;
  };
  readonly onCalendarStateChanged?: () => void;
  readonly ownerId: string;
  readonly scheduleAssistant?: ScheduleMessageHandler;
  readonly stateRepository: RouterStateRepository;
  readonly taskTimeZone?: string;
}

/** Routes owner-only onboarding, new deterministic scheduling, legacy tasks, then Calendar DMs. */
export class OwnerCommandRouter {
  public constructor(private readonly options: OwnerCommandRouterOptions) { }

  public async handle(message: OwnerDirectMessage): Promise<void> {
    if (message.authorId !== this.options.ownerId) {
      return;
    }
    const routedMessage = withGeminiResponseAttribution(
      message,
      this.options.geminiResponseLabelEnabled ?? true,
    );
    const pendingInstruction = parsePendingActionInstruction(routedMessage.content);
    if (pendingInstruction) {
      await this.routePendingAction(routedMessage, pendingInstruction);
      return;
    }

    const command = routedMessage.content.trim().toLowerCase();

    if (command === "/connect" || command === "connect") {
      if (!this.options.oauthService) {
        await routedMessage.reply("Google Calendar integration is not configured for this bot.");
        return;
      }
      const authorization = this.options.oauthService.beginAuthorization(this.options.ownerId);
      await routedMessage.reply(
        `Open this secure Google authorization link, then return here: ${authorization.authorizationUrl}`,
      );
      return;
    }

    if (command === "/disconnect" || command === "disconnect") {
      if (!this.options.oauthService || !this.options.stateRepository.clearGoogleOAuth) {
        await routedMessage.reply("Google Calendar integration is not configured for this bot.");
        return;
      }
      this.options.stateRepository.clearGoogleOAuth();
      this.options.onCalendarStateChanged?.();
      await routedMessage.reply("Google Calendar has been disconnected from this bot.");
      return;
    }

    if (command === "/status" || command === "status") {
      await this.replyWithStatus(routedMessage);
      return;
    }

    if (isCalendarManagementCommand(routedMessage.content)) {
      if (this.options.calendarManagementAssistant) {
        await this.options.calendarManagementAssistant.handle(routedMessage);
      } else {
        await routedMessage.reply("Google Calendar management is not configured for this bot.");
      }
      return;
    }

    if (isReservedScheduledCommand(routedMessage.content)) {
      if (this.options.scheduleAssistant && await this.options.scheduleAssistant.handle(routedMessage)) {
        return;
      }
      await routedMessage.reply("I could not find that scheduled item.");
      return;
    }

    const unifiedRoute = await this.routeUnifiedNaturalLanguage(routedMessage);
    if (unifiedRoute === "handled") {
      return;
    }

    if (this.options.scheduleAssistant && await this.options.scheduleAssistant.handle(routedMessage)) {
      return;
    }

    if (this.options.calendarAssistant && isDeferredLegacyCalendarDelete(routedMessage.content)) {
      await this.options.calendarAssistant.handle(routedMessage);
      return;
    }

    if (this.options.localTaskAssistant?.isTaskInput(routedMessage.content)) {
      await this.options.localTaskAssistant.handle(routedMessage);
      return;
    }

    const naturalLanguageRoute = await this.routeNaturalLanguage(routedMessage);
    if (naturalLanguageRoute === "handled") {
      return;
    }

    if (this.options.calendarAssistant) {
      await this.options.calendarAssistant.handle(routedMessage);
      return;
    }

    if (naturalLanguageRoute === "unavailable") {
      await routedMessage.reply("I could not determine whether that is a Calendar request or a local task. Please be more specific.");
      return;
    }

    if (this.options.localTaskAssistant) {
      await routedMessage.reply(
        "I can manage private local tasks. Try 'remind me at 6pm tomorrow to run' or 'tasks'. Google Calendar is not configured.",
      );
      return;
    }

    await routedMessage.reply(
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
      this.options.namedDeleteHandler,
      this.options.scheduleAssistant,
      this.options.localTaskAssistant,
      this.options.calendarManagementAssistant,
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

  private async routeUnifiedNaturalLanguage(message: OwnerDirectMessage): Promise<"handled" | "unavailable"> {
    const planner = this.options.naturalLanguagePlanner;
    if (!planner) {
      return "unavailable";
    }

    const now = new Date();
    let storedContext: NaturalLanguageContextRecord | undefined;
    try {
      storedContext = this.options.stateRepository.getNaturalLanguageContext?.({
        now,
        ownerId: this.options.ownerId,
      });
    } catch {
      storedContext = undefined;
    }

    let action: NaturalLanguageAction | undefined;
    try {
      action = await planner.plan({
        ...(storedContext ? {
          context: {
            clarificationQuestion: storedContext.clarificationQuestion,
            originalRequest: storedContext.originalRequest,
            reason: storedContext.reason,
            recentMessages: storedContext.recentMessages,
          },
        } : {}),
        now,
        text: message.content,
        timeZone: this.options.taskTimeZone ?? "America/Toronto",
      });
    } catch {
      return "unavailable";
    }

    if (!action) {
      return "unavailable";
    }

    markGeminiResponseUsed(message);
    if (action.action === "ask_clarification") {
      const clarificationQuestion = naturalLanguageClarificationMessage(action.reason);
      try {
        this.options.stateRepository.saveNaturalLanguageContext?.({
          clarificationQuestion,
          expiresAt: new Date(now.valueOf() + 10 * 60 * 1_000),
          now,
          originalRequest: storedContext?.originalRequest ?? message.content,
          ownerId: this.options.ownerId,
          recentMessages: storedContext
            ? [...storedContext.recentMessages, message.content].slice(-4)
            : [],
          reason: action.reason,
        });
      } catch {
        // Context is an enhancement; never block a safe clarification response.
      }
      await message.reply(clarificationQuestion);
      return "handled";
    }

    try {
      this.options.stateRepository.clearNaturalLanguageContext?.({ ownerId: this.options.ownerId });
    } catch {
      // A completed action must still be dispatched if cleanup of expired context fails.
    }
    await this.dispatchNaturalLanguageAction(message, action);
    return "handled";
  }

  private async dispatchNaturalLanguageAction(message: OwnerDirectMessage, action: NaturalLanguageAction): Promise<void> {
    switch (action.action) {
      case "create_calendar_event":
        if (this.options.scheduleAssistant?.handleNaturalLanguageAction &&
          await this.options.scheduleAssistant.handleNaturalLanguageAction(message, action)) {
          return;
        }
        if (this.options.calendarAssistant?.handleNaturalLanguageAction) {
          await this.options.calendarAssistant.handleNaturalLanguageAction(message, action);
          return;
        }
        await message.reply("Google Calendar is not configured for this bot.");
        return;
      case "list_calendar":
      case "move_calendar_event":
      case "delete_calendar_event":
      case "manage_calendar_attendees":
      case "set_calendar_reminder":
        if (this.options.calendarAssistant?.handleNaturalLanguageAction) {
          await this.options.calendarAssistant.handleNaturalLanguageAction(message, action);
        } else {
          await message.reply("Google Calendar is not configured for this bot.");
        }
        return;
      case "create_task_or_reminder":
        if ((action.scheduleKind === "reminder" || !action.startTime) &&
          this.options.scheduleAssistant?.handleNaturalLanguageAction) {
          await this.options.scheduleAssistant.handleNaturalLanguageAction(message, action);
          return;
        }
        if (this.options.localTaskAssistant?.handleNaturalLanguageAction) {
          await this.options.localTaskAssistant.handleNaturalLanguageAction(message, action);
        } else {
          await message.reply("Local task support is not configured for this bot.");
        }
        return;
      case "list_tasks":
      case "complete_task":
        if (this.options.localTaskAssistant?.handleNaturalLanguageAction) {
          await this.options.localTaskAssistant.handleNaturalLanguageAction(message, action);
        } else {
          await message.reply("Local task support is not configured for this bot.");
        }
        return;
      case "delete_task": {
        const isSingleNamedDelete = action.scope === "single" && Boolean(action.selector?.title.trim());
        if (isSingleNamedDelete && this.options.namedDeleteHandler) {
          // Resolve across every configured deletion domain before selecting an
          // exact adapter. Scheduling remains the fallback only when the
          // cross-domain coordinator is unavailable.
          await this.options.namedDeleteHandler.handleNaturalLanguageAction(message, action);
          return;
        }
        if (isSingleNamedDelete && this.options.scheduleAssistant?.handleNaturalLanguageAction) {
          const handled = await this.options.scheduleAssistant.handleNaturalLanguageAction(message, action);
          if (handled) {
            return;
          }
        }
        if (this.options.localTaskAssistant?.handleNaturalLanguageAction) {
          await this.options.localTaskAssistant.handleNaturalLanguageAction(message, action);
        } else {
          await message.reply("Local task support is not configured for this bot.");
        }
        return;
      }
      case "show_agenda":
      case "cleanup_schedule":
        if (this.options.scheduleAssistant?.handleNaturalLanguageAction) {
          await this.options.scheduleAssistant.handleNaturalLanguageAction(message, action);
        } else {
          await message.reply("Scheduling support is not configured for this bot.");
        }
        return;
      case "ask_clarification":
        return;
    }
  }

  private async routeNaturalLanguage(message: OwnerDirectMessage): Promise<"handled" | "fallthrough" | "unavailable"> {
    if (this.options.naturalLanguagePlanner) {
      return "unavailable";
    }
    const classifier = this.options.naturalLanguageClassifier;
    if (!classifier) {
      return "fallthrough";
    }

    let decision: NaturalLanguageDomainDecision | undefined;
    try {
      decision = await classifier.classify({
        now: new Date(),
        text: message.content,
        timeZone: this.options.taskTimeZone ?? "America/Toronto",
      });
    } catch {
      return "unavailable";
    }

    // Hosted classification is optional. Fall through to a configured Calendar
    // handler during provider failures, then clarify only if no handler can decide.
    if (!decision) {
      return "unavailable";
    }

    markGeminiResponseUsed(message);
    if ("kind" in decision) {
      await message.reply(naturalLanguageClarificationMessage(decision.reason));
      return "handled";
    }

    if (decision.domain === "task") {
      if (!this.options.localTaskAssistant) {
        await message.reply("Local task support is not configured for this bot.");
        return "handled";
      }
      await this.options.localTaskAssistant.handleNaturalLanguage(message);
      return "handled";
    }

    if (!this.options.calendarAssistant) {
      await message.reply("Google Calendar is not configured for this bot.");
      return "handled";
    }
    await this.options.calendarAssistant.handle(message);
    return "handled";
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

    let googleCredentials: GoogleOAuthCredentials | undefined;
    try {
      googleCredentials = this.options.stateRepository.getGoogleOAuth();
    } catch {
      status.push(
        "Google Calendar is linked, but I could not read its current status. Try /connect again if this persists.",
      );
      await message.reply(status.join(" "));
      return;
    }

    if (!googleCredentials) {
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

function isReservedScheduledCommand(content: string): boolean {
  return /^done\s+[a-f0-9-]{36}$/iu.test(content.trim());
}

function naturalLanguageClarificationMessage(reason: NaturalLanguageClarificationReason): string {
  switch (reason) {
    case "ambiguous_domain":
      return "Do you mean a Google Calendar event or a local task? Please say which one you want.";
    case "ambiguous_intent":
      return "I am not sure what action you want. Please say whether you want to create, list, move, complete, or cancel something.";
    case "invalid_value":
      return "I could not understand one of the values in that request. Please provide a valid date or time.";
    case "missing_required_detail":
      return "I need a little more detail before I can do that. Please include the missing date, time, title, or task description.";
    case "unsupported_intent":
      return "I can currently manage Calendar events and one-time local tasks, but not that kind of request.";
  }
}

function isCalendarManagementCommand(content: string): boolean {
  return /^(?:calendars|list\s+calendars|(?:add|create)\s+calendar|edit\s+calendar|show\s+calendar|hide\s+calendar|(?:delete|remove)\s+calendar|resume\s+calendar\s+migration)\b/iu.test(content.trim());
}
