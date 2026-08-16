import { CalendarAssistant } from "./application/calendar-assistant.js";
import { OwnerCommandRouter } from "./application/owner-command-router.js";
import { getBotIntegrationConfig, getGeminiFallbackConfig, loadConfig } from "./config.js";
import { DiscordBot } from "./discord/discord-bot.js";
import { GoogleCalendarApi } from "./google/calendar-api.js";
import { GoogleOAuthCallbackHandler } from "./google/oauth-callback.js";
import { GoogleApiOAuthProvider, GoogleOAuthService } from "./google/oauth-service.js";
import { startHealthServer, type HealthServer } from "./http/health-server.js";
import { createLogger } from "./logger.js";
import { GeminiStructuredCommandPlanner } from "./nlp/gemini-structured-planner.js";
import { AppStateRepository } from "./persistence/state-repository.js";
import { ReminderScheduler } from "./reminders/reminder-scheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const integration = getBotIntegrationConfig(config);
  const geminiFallback = getGeminiFallbackConfig(config);

  let stateRepository: AppStateRepository | undefined;
  let discordBot: DiscordBot | undefined;
  let reminderScheduler: ReminderScheduler | undefined;
  let healthServer: HealthServer | undefined;

  try {
    let oauthCallback: GoogleOAuthCallbackHandler | undefined;

    if (integration) {
      stateRepository = new AppStateRepository({
        databasePath: config.DATABASE_PATH,
        encryptionSecret: integration.encryptionKey,
      });
      const oauthService = new GoogleOAuthService({
        provider: new GoogleApiOAuthProvider({
          clientId: integration.googleClientId,
          clientSecret: integration.googleClientSecret,
          redirectUri: integration.googleRedirectUri,
        }),
        stateRepository,
      });
      const calendarGateway = new GoogleCalendarApi({
        clientId: integration.googleClientId,
        clientSecret: integration.googleClientSecret,
        redirectUri: integration.googleRedirectUri,
        stateRepository,
      });
      const commandPlanner = geminiFallback
        ? new GeminiStructuredCommandPlanner({
          apiKey: geminiFallback.apiKey,
          model: geminiFallback.model,
        })
        : undefined;
      const calendarAssistant = new CalendarAssistant({
        calendarGateway,
        ...(commandPlanner ? { commandPlanner } : {}),
        logger,
        ownerId: integration.discordOwnerId,
        stateRepository,
      });
      const commandRouter = new OwnerCommandRouter({
        calendarAssistant,
        calendarReader: calendarGateway,
        oauthService,
        ownerId: integration.discordOwnerId,
        stateRepository,
      });
      discordBot = new DiscordBot({
        logger,
        onOwnerDirectMessage: (message) => commandRouter.handle(message),
        ownerId: integration.discordOwnerId,
        token: integration.discordBotToken,
      });
      reminderScheduler = new ReminderScheduler({
        calendarGateway,
        logger,
        pollIntervalMilliseconds: config.REMINDER_POLL_INTERVAL_SECONDS * 1_000,
        sendOwnerMessage: async (content) => {
          await discordBot?.sendOwnerMessage(content);
        },
        stateRepository,
      });
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

    healthServer = await startHealthServer({
      host: config.HOST,
      logger,
      ...(oauthCallback ? { oauthCallback } : {}),
      port: config.PORT,
    });

    if (discordBot) {
      await discordBot.start();
      reminderScheduler?.start();
    } else {
      logger.warn(
        "Starting in health-only mode; configure Discord, Google OAuth, and ENCRYPTION_KEY to enable the bot",
      );
    }
  } catch (error: unknown) {
    reminderScheduler?.stop();
    await discordBot?.stop();
    await healthServer?.close();
    stateRepository?.close();
    throw error;
  }

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "Shutting down");
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
