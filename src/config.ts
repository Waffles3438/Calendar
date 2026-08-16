import { z } from "zod";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyStringToUndefined, z.string().trim().min(1).optional());
const geminiModel = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u).optional(),
);

const configSchema = z
  .object({
    NODE_ENV: z.preprocess(
      emptyStringToUndefined,
      z.enum(["development", "test", "production"]).default("development"),
    ),
    HOST: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).default("127.0.0.1")),
    PORT: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(1).max(65_535).default(3_000),
    ),
    LOG_LEVEL: z.preprocess(emptyStringToUndefined, z.enum(LOG_LEVELS).default("info")),
    DATABASE_PATH: z.preprocess(
      emptyStringToUndefined,
      z.string().trim().min(1).default("./data/calendar-bot.sqlite"),
    ),
    REMINDER_POLL_INTERVAL_SECONDS: z.preprocess(
      emptyStringToUndefined,
      z.coerce.number().int().min(15).max(300).default(60),
    ),
    DISCORD_BOT_TOKEN: optionalString,
    DISCORD_OWNER_ID: z.preprocess(
      emptyStringToUndefined,
      z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake ID").optional(),
    ),
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GOOGLE_REDIRECT_URI: z.preprocess(emptyStringToUndefined, z.string().url().optional()),
    ENCRYPTION_KEY: z.preprocess(emptyStringToUndefined, z.string().min(32).optional()),
    GEMINI_API_KEY: optionalString,
    GEMINI_MODEL: geminiModel,
  })
  .superRefine((value, context) => {
    if (value.DISCORD_BOT_TOKEN && !value.DISCORD_OWNER_ID) {
      context.addIssue({
        code: "custom",
        message: "DISCORD_OWNER_ID is required when DISCORD_BOT_TOKEN is configured",
        path: ["DISCORD_OWNER_ID"],
      });
    }

    const googleValues = [value.GOOGLE_CLIENT_ID, value.GOOGLE_CLIENT_SECRET, value.GOOGLE_REDIRECT_URI];
    if (googleValues.some(Boolean) && !googleValues.every(Boolean)) {
      context.addIssue({
        code: "custom",
        message:
          "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be configured together",
        path: ["GOOGLE_CLIENT_ID"],
      });
    }

    const geminiValues = [value.GEMINI_API_KEY, value.GEMINI_MODEL];
    if (geminiValues.some(Boolean) && !geminiValues.every(Boolean)) {
      context.addIssue({
        code: "custom",
        message: "GEMINI_API_KEY and GEMINI_MODEL must be configured together",
        path: ["GEMINI_API_KEY"],
      });
    }
  });

export type AppConfig = z.output<typeof configSchema>;

export interface BotIntegrationConfig {
  readonly discordBotToken: string;
  readonly discordOwnerId: string;
  readonly encryptionKey: string;
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  readonly googleRedirectUri: string;
}

export interface GeminiFallbackConfig {
  readonly apiKey: string;
  readonly model: string;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(environment);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`Invalid configuration: ${issues}`);
  }

  return result.data;
}

/** Returns no integration in health-only mode, or fails closed for a partial bot setup. */
export function getBotIntegrationConfig(config: AppConfig): BotIntegrationConfig | undefined {
  const configuredValues = [
    config.DISCORD_BOT_TOKEN,
    config.DISCORD_OWNER_ID,
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI,
    config.ENCRYPTION_KEY,
  ];

  if (!configuredValues.some(Boolean)) {
    return undefined;
  }

  if (
    !config.DISCORD_BOT_TOKEN ||
    !config.DISCORD_OWNER_ID ||
    !config.GOOGLE_CLIENT_ID ||
    !config.GOOGLE_CLIENT_SECRET ||
    !config.GOOGLE_REDIRECT_URI ||
    !config.ENCRYPTION_KEY
  ) {
    throw new ConfigurationError(
      "DISCORD_BOT_TOKEN, DISCORD_OWNER_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, and ENCRYPTION_KEY are all required to enable the bot",
    );
  }

  return {
    discordBotToken: config.DISCORD_BOT_TOKEN,
    discordOwnerId: config.DISCORD_OWNER_ID,
    encryptionKey: config.ENCRYPTION_KEY,
    googleClientId: config.GOOGLE_CLIENT_ID,
    googleClientSecret: config.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: config.GOOGLE_REDIRECT_URI,
  };
}

/** Returns no fallback when Gemini is disabled, or fails closed for partial setup. */
export function getGeminiFallbackConfig(config: AppConfig): GeminiFallbackConfig | undefined {
  if (!config.GEMINI_API_KEY && !config.GEMINI_MODEL) {
    return undefined;
  }

  if (!config.GEMINI_API_KEY || !config.GEMINI_MODEL) {
    throw new ConfigurationError("GEMINI_API_KEY and GEMINI_MODEL must be configured together");
  }

  return { apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL };
}
