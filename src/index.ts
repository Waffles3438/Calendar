import { CalendarAssistant } from "./application/calendar-assistant.js";
import { OwnerCommandRouter } from "./application/owner-command-router.js";
import {
  getGeminiFallbackConfig,
  getGoogleCalendarConfig,
  getLocalBotConfig,
  loadConfig,
} from "./config.js";
import { DiscordBot } from "./discord/discord-bot.js";
import { GoogleCalendarApi } from "./google/calendar-api.js";
import { CalendarChangeTracker, TrackedCalendarGateway } from "./google/calendar-change-tracker.js";
import { GoogleOAuthCallbackHandler } from "./google/oauth-callback.js";
import { GoogleApiOAuthProvider, GoogleOAuthService } from "./google/oauth-service.js";
import { startHealthServer, type HealthServer } from "./http/health-server.js";
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
      let calendarGateway: TrackedCalendarGateway | undefined;
      let calendarChangeTracker: CalendarChangeTracker | undefined;
      let oauthService: GoogleOAuthService | undefined;
      if (googleIntegration) {
        oauthService = new GoogleOAuthService({
          provider: new GoogleApiOAuthProvider({
            clientId: googleIntegration.googleClientId,
            clientSecret: googleIntegration.googleClientSecret,
            redirectUri: googleIntegration.googleRedirectUri,
          }),
          stateRepository,
        });
        const rawCalendarGateway = new GoogleCalendarApi({
          clientId: googleIntegration.googleClientId,
          clientSecret: googleIntegration.googleClientSecret,
          redirectUri: googleIntegration.googleRedirectUri,
          stateRepository,
        });
        calendarChangeTracker = new CalendarChangeTracker();
        calendarGateway = new TrackedCalendarGateway(rawCalendarGateway, calendarChangeTracker);
        calendarAssistant = new CalendarAssistant({
          calendarGateway,
          logger,
          ownerId: localIntegration.discordOwnerId,
          stateRepository,
        });
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
      const agendaService = new AgendaService({
        ...(calendarGateway ? { calendarGateway } : {}),
        legacyTaskReader: stateRepository,
        ownerId: localIntegration.discordOwnerId,
        schedulingRepository,
        timeZone: localIntegration.taskTimeZone,
      });
      const commandRouter = new OwnerCommandRouter({
        ...(calendarAssistant ? { calendarAssistant } : {}),
        ...(calendarGateway ? { calendarReader: calendarGateway } : {}),
        ...(oauthService ? { oauthService } : {}),
        ...(naturalLanguagePlanner ? { naturalLanguagePlanner } : {}),
        ...(calendarChangeTracker ? {
          onCalendarStateChanged: () => calendarChangeTracker?.markChanged(),
        } : {}),
        geminiResponseLabelEnabled: config.GEMINI_RESPONSE_LABEL_ENABLED,
        localTaskAssistant,
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

      if (oauthService) {
        oauthCallback = new GoogleOAuthCallbackHandler({
          logger,
          oauthService,
          onAuthorized: async () => {
            calendarChangeTracker?.markChanged();
            await discordBot?.sendOwnerMessage(
              "Google Calendar is connected. Send /status to verify the primary calendar.",
            );
          },
        });
      }
    }

    healthServer = await startHealthServer({
      host: config.HOST,
      logger,
      ...(oauthCallback ? { oauthCallback } : {}),
      port: config.PORT,
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
