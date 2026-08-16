import pino, { type DestinationStream, type Logger } from "pino";

import type { LogLevel } from "./config.js";

const REDACTED_PATHS = [
  "DISCORD_BOT_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "GEMINI_API_KEY",
  "ENCRYPTION_KEY",
  "authorization",
  "accessToken",
  "refreshToken",
  "oauth.accessToken",
  "oauth.refreshToken",
  "session.accessToken",
  "session.refreshToken",
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    base: null,
    level,
    redact: {
      censor: "[REDACTED]",
      paths: REDACTED_PATHS,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  return destination ? pino(options, destination) : pino(options);
}
