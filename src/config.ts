import { IANAZone } from "luxon";
import { z } from "zod";

import { DEFAULT_TASK_TIME_ZONE } from "./tasks/task-time.js";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const emptyStringToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalString = z.preprocess(emptyStringToUndefined, z.string().trim().min(1).optional());
const booleanFlag = (defaultValue: boolean) => z.preprocess(
  (value: unknown) => {
    if (typeof value !== "string") {
      return value;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "") {
      return undefined;
    }
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
    return value;
  },
  z.boolean().default(defaultValue),
);
const geminiModel = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u).optional(),
);
const taskTimeZone = z.preprocess(
  emptyStringToUndefined,
  z.string()
    .trim()
    .min(1)
    .max(100)
    .refine((value) => IANAZone.isValidZone(value), "must be a valid IANA time zone")
    .default(DEFAULT_TASK_TIME_ZONE),
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
    LOCAL_TASK_TIME_ZONE: taskTimeZone,
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
    GEMINI_NATURAL_LANGUAGE_ENABLED: booleanFlag(true),
    GEMINI_RESPONSE_LABEL_ENABLED: booleanFlag(true),
    DAILY_AGENDA_ENABLED: booleanFlag(true),
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
    const localRuntimeValues = [value.DISCORD_BOT_TOKEN, value.DISCORD_OWNER_ID, value.ENCRYPTION_KEY];
    if (googleValues.every(Boolean) && !localRuntimeValues.some(Boolean)) {
      context.addIssue({
        code: "custom",
        message:
          "DISCORD_BOT_TOKEN, DISCORD_OWNER_ID, and ENCRYPTION_KEY are required when Google Calendar is configured",
        path: ["DISCORD_BOT_TOKEN"],
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

export interface LocalBotConfig {
  readonly discordBotToken: string;
  readonly discordOwnerId: string;
  readonly encryptionKey: string;
  readonly taskTimeZone: string;
}

export interface GoogleCalendarConfig {
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  readonly googleRedirectUri: string;
}

/** Backwards-compatible full integration shape for callers that require both services. */
export interface BotIntegrationConfig extends LocalBotConfig, GoogleCalendarConfig { }

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

/** Returns no local bot runtime in health-only mode, or fails closed for a partial local setup. */
export function getLocalBotConfig(config: AppConfig): LocalBotConfig | undefined {
  const configuredValues = [config.DISCORD_BOT_TOKEN, config.DISCORD_OWNER_ID, config.ENCRYPTION_KEY];
  if (!configuredValues.some(Boolean)) {
    return undefined;
  }
  if (!config.DISCORD_BOT_TOKEN || !config.DISCORD_OWNER_ID || !config.ENCRYPTION_KEY) {
    throw new ConfigurationError(
      "DISCORD_BOT_TOKEN, DISCORD_OWNER_ID, and ENCRYPTION_KEY are all required to enable Discord and local tasks",
    );
  }

  return {
    discordBotToken: config.DISCORD_BOT_TOKEN,
    discordOwnerId: config.DISCORD_OWNER_ID,
    encryptionKey: config.ENCRYPTION_KEY,
    taskTimeZone: config.LOCAL_TASK_TIME_ZONE,
  };
}

/** Returns no Google integration when it is omitted, or fails closed for partial settings. */
export function getGoogleCalendarConfig(config: AppConfig): GoogleCalendarConfig | undefined {
  const configuredValues = [config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, config.GOOGLE_REDIRECT_URI];
  if (!configuredValues.some(Boolean)) {
    return undefined;
  }
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REDIRECT_URI) {
    throw new ConfigurationError(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be configured together",
    );
  }

  return {
    googleClientId: config.GOOGLE_CLIENT_ID,
    googleClientSecret: config.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: config.GOOGLE_REDIRECT_URI,
  };
}

/**
 * Retains the original all-services contract for external callers while the
 * application itself can start local tasks without Google configuration.
 */
export function getBotIntegrationConfig(config: AppConfig): BotIntegrationConfig | undefined {
  const local = getLocalBotConfig(config);
  const google = getGoogleCalendarConfig(config);
  if (!local && !google) {
    return undefined;
  }
  if (!local || !google) {
    throw new ConfigurationError(
      "DISCORD_BOT_TOKEN, DISCORD_OWNER_ID, ENCRYPTION_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI are all required for the full Google Calendar integration",
    );
  }
  return { ...local, ...google };
}

/** Returns no fallback when Gemini is disabled, or fails closed for partial setup. */
export function getGeminiFallbackConfig(config: AppConfig): GeminiFallbackConfig | undefined {
  if (!config.GEMINI_NATURAL_LANGUAGE_ENABLED) {
    return undefined;
  }

  if (!config.GEMINI_API_KEY && !config.GEMINI_MODEL) {
    return undefined;
  }

  if (!config.GEMINI_API_KEY || !config.GEMINI_MODEL) {
    throw new ConfigurationError("GEMINI_API_KEY and GEMINI_MODEL must be configured together");
  }

  return { apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL };
}
