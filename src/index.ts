import type { CalendarAssistant } from "./application/calendar-assistant.js";
import {
  createCalendarManagementRuntime,
  type CalendarManagementRuntime,
} from "./application/calendar-management-runtime.js";
import type { CalendarManagementAssistant } from "./application/calendar-management-assistant.js";
import { NamedDeleteHandler } from "./application/named-delete-handler.js";
import { NamedDeleteResolver } from "./application/named-delete-resolver.js";
import { OwnerCommandRouter } from "./application/owner-command-router.js";
import {
  getGeminiFallbackConfig,
  getGoogleCalendarConfig,
  getLocalBotConfig,
  getWebUiConfig,
  loadConfig,
} from "./config.js";
import { DiscordBot } from "./discord/discord-bot.js";
import type { TrackedCalendarGateway, CalendarChangeTracker } from "./google/calendar-change-tracker.js";
import type { GoogleOAuthCallbackHandler } from "./google/oauth-callback.js";
import type { GoogleOAuthService } from "./google/oauth-service.js";
import { startHealthServer, type HealthServer } from "./http/health-server.js";
import type { CalendarWebApplication } from "./http/calendar-web.js";
import { createLogger } from "./logger.js";
import { CachingNaturalLanguageActionPlanner } from "./nlp/caching-natural-language-action-planner.js";
import { GeminiActionPlanner } from "./nlp/gemini-action-planner.js";
import { AppStateRepository } from "./persistence/state-repository.js";
import { ReminderScheduler } from "./reminders/reminder-scheduler.js";
import { AgendaService } from "./scheduling/agenda-service.js";
import { DailyAgendaScheduler } from "./scheduling/daily-agenda-scheduler.js";
import { ScheduleAssistant } from "./scheduling/schedule-assistant.js";
import { ScheduledReminderScheduler } from "./scheduling/scheduled-reminder-scheduler.js";
import { SchedulingRepository } from "./scheduling/scheduling-repository.js";
import { LocalTaskAssistant } from "./tasks/local-task-assistant.js";
import { LocalTaskReminderScheduler } from "./tasks/local-task-reminder-scheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const localIntegration = getLocalBotConfig(config);
  const googleIntegration = getGoogleCalendarConfig(config);
  const geminiFallback = getGeminiFallbackConfig(config);
  const webIntegration = getWebUiConfig(config);

  logger.info({
    geminiApiKeyConfigured: Boolean(config.GEMINI_API_KEY),
    geminiModel: config.GEMINI_MODEL ?? null,
    geminiNaturalLanguageEnabled: config.GEMINI_NATURAL_LANGUAGE_ENABLED,
    geminiPlannerConfigured: Boolean(geminiFallback),
    geminiResponseLabelEnabled: config.GEMINI_RESPONSE_LABEL_ENABLED,
  }, "Gemini natural-language planner configuration");

  let stateRepository: AppStateRepository | undefined;
  let schedulingRepository: SchedulingRepository | undefined;
  let discordBot: DiscordBot | undefined;
  let reminderScheduler: ReminderScheduler | undefined;
  let localTaskReminderScheduler: LocalTaskReminderScheduler | undefined;
  let scheduledReminderScheduler: ScheduledReminderScheduler | undefined;
  let dailyAgendaScheduler: DailyAgendaScheduler | undefined;
  let healthServer: HealthServer | undefined;
  let calendarWebApplication: CalendarWebApplication | undefined;

  try {
    let oauthCallback: GoogleOAuthCallbackHandler | undefined;

    if (localIntegration) {
      stateRepository = new AppStateRepository({
        databasePath: config.DATABASE_PATH,
        encryptionSecret: localIntegration.encryptionKey,
      });
      schedulingRepository = new SchedulingRepository({
        databasePath: config.DATABASE_PATH,
        encryptionSecret: localIntegration.encryptionKey,
      });

      const localTaskAssistant = new LocalTaskAssistant({
        logger,
        ownerId: localIntegration.discordOwnerId,
        stateRepository,
        timeZone: localIntegration.taskTimeZone,
      });

      let calendarAssistant: CalendarAssistant | undefined;
      let calendarManagementAssistant: CalendarManagementAssistant | undefined;
      let calendarGateway: TrackedCalendarGateway | undefined;
      let calendarChangeTracker: CalendarChangeTracker | undefined;
      let oauthService: GoogleOAuthService | undefined;
      let calendarRuntime: CalendarManagementRuntime | undefined;
      if (googleIntegration) {
        calendarRuntime = createCalendarManagementRuntime({
          ...(webIntegration ? { webIntegration } : {}),
          cookieSecure: config.NODE_ENV === "production",
          googleIntegration,
          localIntegration,
          logger,
          onAuthorized: async () => {
            calendarRuntime?.calendarChangeTracker.markChanged();
            await discordBot?.sendOwnerMessage(
              "Google Calendar is connected. Send /status to verify the primary calendar.",
            );
          },
          stateRepository,
        });
        calendarAssistant = calendarRuntime.calendarAssistant;
        calendarManagementAssistant = calendarRuntime.calendarManagementAssistant;
        calendarGateway = calendarRuntime.calendarGateway;
        calendarChangeTracker = calendarRuntime.calendarChangeTracker;
        oauthService = calendarRuntime.oauthService;
        oauthCallback = calendarRuntime.oauthCallback;
        calendarWebApplication = calendarRuntime.calendarWebApplication;
      }

      const naturalLanguagePlanner = geminiFallback
        ? new CachingNaturalLanguageActionPlanner({
          ...(calendarChangeTracker ? { calendarChanges: calendarChangeTracker } : {}),
          model: geminiFallback.model,
          ownerId: localIntegration.discordOwnerId,
          planner: new GeminiActionPlanner({
            apiKey: geminiFallback.apiKey,
            logger,
            model: geminiFallback.model,
          }),
        })
        : undefined;

      const scheduleAssistant = new ScheduleAssistant({
        ...(calendarGateway ? { calendarGateway } : {}),
        geminiEnabled: Boolean(geminiFallback),
        legacyTaskReader: stateRepository,
        logger,
        ownerId: localIntegration.discordOwnerId,
        schedulingRepository,
        stateRepository,
        timeZone: localIntegration.taskTimeZone,
      });
      const namedDeleteResolver = new NamedDeleteResolver({
        ...(calendarGateway ? { calendarGateway } : {}),
        logger,
        ownerId: localIntegration.discordOwnerId,
        schedulingRepository,
        stateRepository,
        timeZone: localIntegration.taskTimeZone,
      });
      const namedDeleteHandler = new NamedDeleteHandler({
        ...(calendarAssistant ? { calendarAssistant } : {}),
        ...(calendarGateway ? { calendarGateway } : {}),
        localTaskAssistant,
        ownerId: localIntegration.discordOwnerId,
        resolver: namedDeleteResolver,
        scheduleAssistant,
        schedulingRepository,
        stateRepository,
        timeZone: localIntegration.taskTimeZone,
      });
      const agendaService = new AgendaService({
        ...(calendarGateway ? { calendarGateway } : {}),
        legacyTaskReader: stateRepository,
        ownerId: localIntegration.discordOwnerId,
        schedulingRepository,
        timeZone: localIntegration.taskTimeZone,
      });
      const commandRouter = new OwnerCommandRouter({
        ...(calendarAssistant ? { calendarAssistant } : {}),
        ...(calendarManagementAssistant ? { calendarManagementAssistant } : {}),
        ...(calendarGateway ? { calendarReader: calendarGateway } : {}),
        ...(oauthService ? { oauthService } : {}),
        ...(naturalLanguagePlanner ? { naturalLanguagePlanner } : {}),
        ...(calendarChangeTracker ? {
          onCalendarStateChanged: () => calendarChangeTracker?.markChanged(),
        } : {}),
        geminiResponseLabelEnabled: config.GEMINI_RESPONSE_LABEL_ENABLED,
        localTaskAssistant,
        namedDeleteHandler,
        ownerId: localIntegration.discordOwnerId,
        scheduleAssistant,
        stateRepository,
        taskTimeZone: localIntegration.taskTimeZone,
      });
      discordBot = new DiscordBot({
        logger,
        onOwnerDirectMessage: (message) => commandRouter.handle(message),
        ownerId: localIntegration.discordOwnerId,
        token: localIntegration.discordBotToken,
      });
      localTaskReminderScheduler = new LocalTaskReminderScheduler({
        logger,
        ownerId: localIntegration.discordOwnerId,
        pollIntervalMilliseconds: config.REMINDER_POLL_INTERVAL_SECONDS * 1_000,
        sendOwnerMessage: async (content) => {
          await discordBot?.sendOwnerMessage(content);
        },
        stateRepository,
      });
      scheduledReminderScheduler = new ScheduledReminderScheduler({
        logger,
        ownerId: localIntegration.discordOwnerId,
        pollIntervalMilliseconds: config.REMINDER_POLL_INTERVAL_SECONDS * 1_000,
        sendOwnerMessage: async (content) => {
          await discordBot?.sendOwnerMessage(content);
        },
        stateRepository: schedulingRepository,
      });
      if (config.DAILY_AGENDA_ENABLED) {
        dailyAgendaScheduler = new DailyAgendaScheduler({
          agendaService,
          logger,
          ownerId: localIntegration.discordOwnerId,
          pollIntervalMilliseconds: config.REMINDER_POLL_INTERVAL_SECONDS * 1_000,
          sendOwnerMessage: async (content) => {
            await discordBot?.sendOwnerMessage(content);
          },
          stateRepository: schedulingRepository,
          timeZone: localIntegration.taskTimeZone,
        });
      }

      if (calendarGateway) {
        reminderScheduler = new ReminderScheduler({
          calendarGateway,
          logger,
          pollIntervalMilliseconds: config.REMINDER_POLL_INTERVAL_SECONDS * 1_000,
          sendOwnerMessage: async (content) => {
            await discordBot?.sendOwnerMessage(content);
          },
          stateRepository,
        });
      }

    }

    healthServer = await startHealthServer({
      host: config.HOST,
      logger,
      ...(oauthCallback ? { oauthCallback } : {}),
      port: config.PORT,
      ...(calendarWebApplication ? { webApplication: calendarWebApplication } : {}),
    });

    if (discordBot) {
      await discordBot.start();
      localTaskReminderScheduler?.start();
      scheduledReminderScheduler?.start();
      dailyAgendaScheduler?.start();
      reminderScheduler?.start();
    } else {
      logger.warn(
        "Starting in health-only mode; configure DISCORD_BOT_TOKEN, DISCORD_OWNER_ID, and ENCRYPTION_KEY to enable Discord and local tasks",
      );
    }
  } catch (error: unknown) {
    localTaskReminderScheduler?.stop();
    scheduledReminderScheduler?.stop();
    dailyAgendaScheduler?.stop();
    reminderScheduler?.stop();
    await discordBot?.stop();
    await healthServer?.close();
    schedulingRepository?.close();
    stateRepository?.close();
    throw error;
  }

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "Shutting down");
    localTaskReminderScheduler?.stop();
    scheduledReminderScheduler?.stop();
    dailyAgendaScheduler?.stop();
    reminderScheduler?.stop();
    void Promise.all([discordBot?.stop(), healthServer?.close()])
      .then(() => {
        schedulingRepository?.close();
        stateRepository?.close();
        logger.info("Shutdown complete");
      })
      .catch((error: unknown) => {
        logger.error({ error }, "Shutdown failed");
        process.exitCode = 1;
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
