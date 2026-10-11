import type { Logger } from "pino";

import { CalendarAssistant } from "./calendar-assistant.js";
import { CalendarManagementAssistant } from "./calendar-management-assistant.js";
import { CalendarManagementService } from "./calendar-management-service.js";
import {
  ConfigurationError,
  type GoogleCalendarConfig,
  type LocalBotConfig,
  type WebUiConfig,
} from "../config.js";
import {
  GoogleCalendarApi,
  type CalendarGateway,
  type CalendarManagementGateway,
  type GoogleCalendarApiOptions,
} from "../google/calendar-api.js";
import {
  CalendarChangeTracker,
  TrackedCalendarGateway,
  TrackedCalendarManagementGateway,
} from "../google/calendar-change-tracker.js";
import { GoogleOAuthCallbackHandler } from "../google/oauth-callback.js";
import {
  GoogleApiOAuthProvider,
  GoogleOAuthService,
  type GoogleOAuthClientConfig,
  type GoogleOAuthProvider,
} from "../google/oauth-service.js";
import { CalendarWebApplication } from "../http/calendar-web.js";
import { AppStateRepository } from "../persistence/state-repository.js";

/** The durable state surface shared by Discord, the web panel, and Google OAuth. */
export type CalendarManagementRuntimeStateRepository = Pick<
  AppStateRepository,
  | "clearExpiredWebSessions"
  | "consumeGoogleOAuthState"
  | "consumePendingAction"
  | "createCalendarMigrationJob"
  | "createGoogleOAuthState"
  | "createPendingAction"
  | "createWebSession"
  | "deleteWebSession"
  | "getCalendarMigrationJob"
  | "getGoogleOAuth"
  | "getPendingAction"
  | "getWebSession"
  | "listCalendarMigrationEvents"
  | "recordAudit"
  | "remapReminderReferences"
  | "saveGoogleOAuth"
  | "setReminderOverride"
  | "updateCalendarMigrationJob"
  | "upsertCalendarMigrationEvent"
>;

export interface CalendarManagementRuntimeOptions {
  readonly calendarGatewayFactory?: (
    options: GoogleCalendarApiOptions,
  ) => CalendarGateway & CalendarManagementGateway;
  readonly cookieSecure?: boolean;
  readonly googleIntegration: GoogleCalendarConfig;
  readonly localIntegration: LocalBotConfig;
  readonly logger: Logger;
  readonly onAuthorized?: (ownerId: string) => Promise<void> | void;
  readonly oauthProviderFactory?: (config: GoogleOAuthClientConfig) => GoogleOAuthProvider;
  readonly stateRepository: CalendarManagementRuntimeStateRepository;
  readonly webIntegration?: WebUiConfig;
}

export interface CalendarManagementRuntime {
  readonly calendarAssistant: CalendarAssistant;
  readonly calendarChangeTracker: CalendarChangeTracker;
  readonly calendarGateway: TrackedCalendarGateway;
  readonly calendarManagementAssistant: CalendarManagementAssistant;
  readonly calendarManagementGateway: TrackedCalendarManagementGateway;
  readonly calendarManagementService: CalendarManagementService;
  readonly oauthCallback: GoogleOAuthCallbackHandler;
  readonly oauthService: GoogleOAuthService;
  readonly calendarWebApplication?: CalendarWebApplication;
}

/**
 * Builds the single Google/calendar graph used by Discord and the optional
 * authenticated web panel. The gateway wrappers own Calendar cache
 * invalidation; callers only invalidate explicitly for OAuth connect/disconnect.
 */
export function createCalendarManagementRuntime(
  options: CalendarManagementRuntimeOptions,
): CalendarManagementRuntime {
  const ownerId = options.localIntegration.discordOwnerId;
  if (options.webIntegration && options.webIntegration.ownerId !== ownerId) {
    throw new ConfigurationError(
      "WEB_OWNER_ID must match DISCORD_OWNER_ID because the runtime has one owner",
    );
  }

  const oauthConfig: GoogleOAuthClientConfig = {
    clientId: options.googleIntegration.googleClientId,
    clientSecret: options.googleIntegration.googleClientSecret,
    redirectUri: options.googleIntegration.googleRedirectUri,
  };
  const oauthProvider = options.oauthProviderFactory?.(oauthConfig) ?? new GoogleApiOAuthProvider(oauthConfig);
  const oauthService = new GoogleOAuthService({
    provider: oauthProvider,
    stateRepository: options.stateRepository,
  });
  const calendarApiOptions: GoogleCalendarApiOptions = {
    ...oauthConfig,
    stateRepository: options.stateRepository,
  };
  const rawCalendarGateway = options.calendarGatewayFactory
    ? options.calendarGatewayFactory(calendarApiOptions)
    : new GoogleCalendarApi(calendarApiOptions);
  const calendarChangeTracker = new CalendarChangeTracker();
  const calendarGateway = new TrackedCalendarGateway(rawCalendarGateway, calendarChangeTracker);
  const calendarManagementGateway = new TrackedCalendarManagementGateway(rawCalendarGateway, calendarChangeTracker);
  const calendarManagementService = new CalendarManagementService({
    gateway: calendarManagementGateway,
    logger: options.logger,
    ownerId,
    stateRepository: options.stateRepository,
    timeZone: options.localIntegration.taskTimeZone,
  });
  const calendarManagementAssistant = new CalendarManagementAssistant({
    logger: options.logger,
    ownerId,
    service: calendarManagementService,
    stateRepository: options.stateRepository,
  });
  const calendarAssistant = new CalendarAssistant({
    calendarGateway,
    logger: options.logger,
    ownerId,
    stateRepository: options.stateRepository,
  });
  const oauthCallback = new GoogleOAuthCallbackHandler({
    logger: options.logger,
    oauthService,
    onAuthorized: async (authorizedOwnerId) => {
      if (authorizedOwnerId !== ownerId) {
        throw new ConfigurationError("Google OAuth authorization belongs to a different configured owner");
      }
      await options.onAuthorized?.(authorizedOwnerId);
    },
  });

  const calendarWebApplication = options.webIntegration
    ? new CalendarWebApplication({
      ...(options.cookieSecure !== undefined ? { cookieSecure: options.cookieSecure } : {}),
      ownerId,
      service: calendarManagementService,
      stateRepository: options.stateRepository,
      token: options.webIntegration.token,
    })
    : undefined;

  return {
    calendarAssistant,
    calendarChangeTracker,
    calendarGateway,
    calendarManagementAssistant,
    calendarManagementGateway,
    calendarManagementService,
    oauthCallback,
    oauthService,
    ...(calendarWebApplication ? { calendarWebApplication } : {}),
  };
}
