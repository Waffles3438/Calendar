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
import { GoogleOAuthCallbackHandler } from "./google/oauth-callback.js";
import { GoogleApiOAuthProvider, GoogleOAuthService } from "./google/oauth-service.js";
import { startHealthServer, type HealthServer } from "./http/health-server.js";
import { createLogger } from "./logger.js";
import { GeminiStructuredCommandPlanner } from "./nlp/gemini-structured-planner.js";
import { AppStateRepository } from "./persistence/state-repository.js";
import { ReminderScheduler } from "./reminders/reminder-scheduler.js";
import { GeminiStructuredTaskPlanner } from "./tasks/gemini-structured-task-planner.js";
import { LocalTaskAssistant } from "./tasks/local-task-assistant.js";
import { LocalTaskReminderScheduler } from "./tasks/local-task-reminder-scheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const localIntegration = getLocalBotConfig(config);
  const googleIntegration = getGoogleCalendarConfig(config);
  const geminiFallback = getGeminiFallbackConfig(config);

  let stateRepository: AppStateRepository | undefined;
  let discordBot: DiscordBot | undefined;
  let reminderScheduler: ReminderScheduler | undefined;
  let localTaskReminderScheduler: LocalTaskReminderScheduler | undefined;
  let healthServer: HealthServer | undefined;

  try {
    let oauthCallback: GoogleOAuthCallbackHandler | undefined;

    if (localIntegration) {
      stateRepository = new AppStateRepository({
        databasePath: config.DATABASE_PATH,
        encryptionSecret: localIntegration.encryptionKey,
      });

      const taskCommandPlanner = geminiFallback
        ? new GeminiStructuredTaskPlanner({
          apiKey: geminiFallback.apiKey,
          model: geminiFallback.model,
        })
        : undefined;
      const localTaskAssistant = new LocalTaskAssistant({
        ...(taskCommandPlanner ? { commandPlanner: taskCommandPlanner } : {}),
        logger,
        ownerId: localIntegration.discordOwnerId,
        stateRepository,
        timeZone: localIntegration.taskTimeZone,
      });

      let calendarAssistant: CalendarAssistant | undefined;
      let calendarGateway: GoogleCalendarApi | undefined;
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
        calendarGateway = new GoogleCalendarApi({
          clientId: googleIntegration.googleClientId,
          clientSecret: googleIntegration.googleClientSecret,
          redirectUri: googleIntegration.googleRedirectUri,
          stateRepository,
        });
        const calendarCommandPlanner = geminiFallback
          ? new GeminiStructuredCommandPlanner({
            apiKey: geminiFallback.apiKey,
            model: geminiFallback.model,
          })
          : undefined;
        calendarAssistant = new CalendarAssistant({
          calendarGateway,
          ...(calendarCommandPlanner ? { commandPlanner: calendarCommandPlanner } : {}),
          logger,
          ownerId: localIntegration.discordOwnerId,
          stateRepository,
        });
      }

      const commandRouter = new OwnerCommandRouter({
        ...(calendarAssistant ? { calendarAssistant } : {}),
        ...(calendarGateway ? { calendarReader: calendarGateway } : {}),
        ...(oauthService ? { oauthService } : {}),
        localTaskAssistant,
        ownerId: localIntegration.discordOwnerId,
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
      reminderScheduler?.start();
    } else {
      logger.warn(
        "Starting in health-only mode; configure DISCORD_BOT_TOKEN, DISCORD_OWNER_ID, and ENCRYPTION_KEY to enable Discord and local tasks",
      );
    }
  } catch (error: unknown) {
    localTaskReminderScheduler?.stop();
    reminderScheduler?.stop();
    await discordBot?.stop();
    await healthServer?.close();
    stateRepository?.close();
    throw error;
  }

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "Shutting down");
    localTaskReminderScheduler?.stop();
    reminderScheduler?.stop();
    void Promise.all([discordBot?.stop(), healthServer?.close()])
      .then(() => {
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
