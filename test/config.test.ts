import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  getBotIntegrationConfig,
  getGeminiFallbackConfig,
  loadConfig,
} from "../src/config.js";

describe("loadConfig", () => {
  it("uses safe defaults for the standalone health service", () => {
    expect(loadConfig({})).toMatchObject({
      DATABASE_PATH: "./data/calendar-bot.sqlite",
      HOST: "127.0.0.1",
      LOG_LEVEL: "info",
      NODE_ENV: "development",
      PORT: 3_000,
      REMINDER_POLL_INTERVAL_SECONDS: 60,
    });
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "70000" })).toThrow(ConfigurationError);
  });

  it("requires an owner when a Discord token is configured", () => {
    expect(() => loadConfig({ DISCORD_BOT_TOKEN: "token" })).toThrow(
      /DISCORD_OWNER_ID is required/,
    );
  });

  it("requires complete Google OAuth settings", () => {
    expect(() => loadConfig({ GOOGLE_CLIENT_ID: "client-id" })).toThrow(
      /must be configured together/,
    );
  });

  it("rejects a complete Google Calendar configuration without the local bot runtime", () => {
    expect(() => loadConfig({
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REDIRECT_URI: "https://calendar.example.com/oauth/google/callback",
    })).toThrow(/DISCORD_BOT_TOKEN, DISCORD_OWNER_ID, and ENCRYPTION_KEY are required/u);
  });

  it("fails closed when the persisted bot integration is incomplete", () => {
    const partial = loadConfig({
      DISCORD_BOT_TOKEN: "token",
      DISCORD_OWNER_ID: "123456789012345678",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REDIRECT_URI: "https://calendar.example.com/oauth/google/callback",
    });
    expect(() => getBotIntegrationConfig(partial)).toThrow(/ENCRYPTION_KEY/);

    const complete = loadConfig({
      DISCORD_BOT_TOKEN: "token",
      DISCORD_OWNER_ID: "123456789012345678",
      ENCRYPTION_KEY: "x".repeat(48),
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REDIRECT_URI: "https://calendar.example.com/oauth/google/callback",
    });

    expect(getBotIntegrationConfig(complete)).toMatchObject({
      discordOwnerId: "123456789012345678",
      googleRedirectUri: "https://calendar.example.com/oauth/google/callback",
    });
  });
});


describe("getGeminiFallbackConfig", () => {
  it("leaves Gemini disabled when both settings are absent", () => {
    expect(getGeminiFallbackConfig(loadConfig({}))).toBeUndefined();
  });

  it("fails closed when only one Gemini setting is configured", () => {
    expect(() => loadConfig({ GEMINI_API_KEY: "key" })).toThrow(
      /GEMINI_API_KEY and GEMINI_MODEL must be configured together/,
    );
    expect(() => loadConfig({ GEMINI_MODEL: "gemini-3.6-flash" })).toThrow(
      /GEMINI_API_KEY and GEMINI_MODEL must be configured together/,
    );
  });

  it("returns the paired Gemini fallback configuration", () => {
    const config = loadConfig({
      GEMINI_API_KEY: "key",
      GEMINI_MODEL: "gemini-3.6-flash",
    });

    expect(getGeminiFallbackConfig(config)).toEqual({
      apiKey: "key",
      model: "gemini-3.6-flash",
    });
  });
});