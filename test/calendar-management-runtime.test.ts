import { describe, expect, it, vi } from "vitest";

import {
  createCalendarManagementRuntime,
  type CalendarManagementRuntimeStateRepository,
} from "../src/application/calendar-management-runtime.js";
import type {
  CalendarEvent,
  CalendarGateway,
  CalendarManagementGateway,
} from "../src/google/calendar-api.js";
import type { ManagedCalendar } from "../src/domain/calendar-management.js";
import { createLogger } from "../src/logger.js";

const ownerId = "123456789012345678";

function managedCalendar(): ManagedCalendar {
  return {
    accessRole: "owner",
    canDelete: false,
    canManageEvents: true,
    canManageMetadata: true,
    hidden: false,
    id: "primary",
    isPrimary: true,
    readOnly: false,
    selected: true,
    summary: "Benny Wang",
    timeZone: "America/Toronto",
  };
}

function createState(): {
  readonly onAuthorized: ReturnType<typeof vi.fn>;
  readonly recordAudit: ReturnType<typeof vi.fn>;
  readonly repository: CalendarManagementRuntimeStateRepository;
  readonly savedCredentials: ReturnType<typeof vi.fn>;
} {
  const onAuthorized = vi.fn();
  const recordAudit = vi.fn();
  const savedCredentials = vi.fn();
  const repository = {
    clearExpiredWebSessions: vi.fn(),
    consumeGoogleOAuthState: vi.fn(() => ({ ownerId })),
    consumePendingAction: vi.fn(),
    createCalendarMigrationJob: vi.fn(),
    createGoogleOAuthState: vi.fn(),
    createPendingAction: vi.fn(),
    createWebSession: vi.fn(),
    deleteWebSession: vi.fn(),
    getCalendarMigrationJob: vi.fn(),
    getGoogleOAuth: vi.fn(() => undefined),
    getPendingAction: vi.fn(),
    getWebSession: vi.fn(),
    listCalendarMigrationEvents: vi.fn(() => []),
    recordAudit,
    remapReminderReferences: vi.fn(),
    saveGoogleOAuth: savedCredentials,
    setReminderOverride: vi.fn(),
    updateCalendarMigrationJob: vi.fn(),
    upsertCalendarMigrationEvent: vi.fn(),
  } as unknown as CalendarManagementRuntimeStateRepository;
  return { onAuthorized, recordAudit, repository, savedCredentials };
}

function createGateway(): CalendarGateway & CalendarManagementGateway {
  const calendar = managedCalendar();
  const gateway: CalendarGateway & CalendarManagementGateway = {
    createEvent: async (): Promise<CalendarEvent> => {
      throw new Error("not used");
    },
    createManagedCalendar: async (input) => ({
      ...calendar,
      id: "created",
      summary: input.name,
    }),
    deleteEvent: async () => {
      throw new Error("not used");
    },
    deleteManagedCalendar: async () => undefined,
    getEvent: async (): Promise<CalendarEvent> => {
      throw new Error("not used");
    },
    listCalendars: async () => [calendar],
    listEvents: async () => [],
    listManagedCalendars: async () => [calendar],
    listMigrationEvents: async () => [],
    moveCalendarEvent: async () => {
      throw new Error("not used");
    },
    splitRecurringEvent: async (): Promise<CalendarEvent> => {
      throw new Error("not used");
    },
    truncateRecurringEvent: async () => undefined,
    updateEvent: async (): Promise<CalendarEvent> => {
      throw new Error("not used");
    },
    updateManagedCalendar: async () => calendar,
  };
  return gateway;
}

describe("calendar management runtime composition", () => {
  it("shares one owner and invalidates once through the tracked management gateway", async () => {
    const state = createState();
    const gateway = createGateway();
    const provider = {
      createAuthorizationUrl: (stateValue: string) => `https://accounts.example.test/?state=${stateValue}`,
      exchangeAuthorizationCode: async () => ({
        accessToken: "access-token",
        refreshToken: "refresh-token",
      }),
    };
    const runtime = createCalendarManagementRuntime({
      calendarGatewayFactory: () => gateway,
      googleIntegration: {
        googleClientId: "client-id",
        googleClientSecret: "client-secret",
        googleRedirectUri: "https://calendar.example.com/oauth/google/callback",
      },
      localIntegration: {
        discordBotToken: "discord-token",
        discordOwnerId: ownerId,
        encryptionKey: "x".repeat(48),
        taskTimeZone: "America/Toronto",
      },
      logger: createLogger("silent"),
      onAuthorized: state.onAuthorized,
      oauthProviderFactory: () => provider,
      stateRepository: state.repository,
      webIntegration: { ownerId, token: "w".repeat(32) },
    });

    await runtime.calendarManagementService.createCalendar({ templateId: "classes" });
    expect(runtime.calendarChangeTracker.getGeneration()).toBe(1);
    await runtime.calendarManagementService.updateCalendar("primary", { name: "Renamed" });
    expect(runtime.calendarChangeTracker.getGeneration()).toBe(2);
    await runtime.calendarManagementService.setCalendarVisibility("primary", { selected: false });
    expect(runtime.calendarChangeTracker.getGeneration()).toBe(3);
    expect(state.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ actorId: ownerId }));
    expect(runtime.calendarWebApplication).toBeDefined();

    const authorization = runtime.oauthService.beginAuthorization(ownerId);
    await expect(runtime.oauthCallback.handle({
      code: "authorization-code",
      state: authorization.state,
    })).resolves.toMatchObject({ statusCode: 200 });
    expect(state.onAuthorized).toHaveBeenCalledWith(ownerId);
    expect(state.savedCredentials).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    }));
  });

  it("rejects a web owner that would split service and session attribution", () => {
    const state = createState();
    expect(() => createCalendarManagementRuntime({
      calendarGatewayFactory: () => createGateway(),
      googleIntegration: {
        googleClientId: "client-id",
        googleClientSecret: "client-secret",
        googleRedirectUri: "https://calendar.example.com/oauth/google/callback",
      },
      localIntegration: {
        discordBotToken: "discord-token",
        discordOwnerId: ownerId,
        encryptionKey: "x".repeat(48),
        taskTimeZone: "America/Toronto",
      },
      logger: createLogger("silent"),
      stateRepository: state.repository,
      webIntegration: { ownerId: "999999999999999999", token: "w".repeat(32) },
    })).toThrow(/WEB_OWNER_ID must match DISCORD_OWNER_ID/u);
  });
});
