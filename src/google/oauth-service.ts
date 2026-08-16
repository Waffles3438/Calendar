import { randomBytes } from "node:crypto";

import { google } from "googleapis";

import type {
  AppStateRepository,
  GoogleOAuthCredentials,
} from "../persistence/state-repository.js";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

export interface GoogleOAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface GoogleAuthorizationRequest {
  readonly authorizationUrl: string;
  readonly state: string;
}

export interface GoogleOAuthProvider {
  createAuthorizationUrl(state: string): string;
  exchangeAuthorizationCode(code: string): Promise<GoogleOAuthCredentials>;
}

export interface GoogleOAuthStateRepository {
  createGoogleOAuthState(input: {
    expiresAt: Date;
    ownerId: string;
    state: string;
  }): void;
  consumeGoogleOAuthState(input: { now: Date; state: string }): { ownerId: string } | undefined;
  getGoogleOAuth(): GoogleOAuthCredentials | undefined;
  saveGoogleOAuth(credentials: GoogleOAuthCredentials): void;
}

export interface GoogleOAuthServiceOptions {
  readonly now?: () => Date;
  readonly provider: GoogleOAuthProvider;
  readonly randomState?: () => string;
  readonly stateRepository: GoogleOAuthStateRepository;
  readonly stateTtlMilliseconds?: number;
}

export class OAuthStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

export class GoogleOAuthError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

function createRandomState(): string {
  return randomBytes(32).toString("base64url");
}

/** Production Google OAuth provider using the installed googleapis package. */
export class GoogleApiOAuthProvider implements GoogleOAuthProvider {
  public constructor(private readonly config: GoogleOAuthClientConfig) { }

  public createAuthorizationUrl(state: string): string {
    return this.createClient().generateAuthUrl({
      access_type: "offline",
      include_granted_scopes: true,
      prompt: "consent",
      scope: [...GOOGLE_CALENDAR_SCOPES],
      state,
    });
  }

  public async exchangeAuthorizationCode(code: string): Promise<GoogleOAuthCredentials> {
    const client = this.createClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.access_token) {
      throw new GoogleOAuthError("Google did not return an access token");
    }

    return {
      accessToken: tokens.access_token,
      ...(tokens.expiry_date ? { expiresAt: new Date(tokens.expiry_date).toISOString() } : {}),
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    };
  }

  private createClient() {
    return new google.auth.OAuth2(this.config.clientId, this.config.clientSecret, this.config.redirectUri);
  }
}

/** Coordinates an owner-bound, one-time OAuth flow with durable state. */
export class GoogleOAuthService {
  private readonly now: () => Date;
  private readonly randomState: () => string;
  private readonly stateTtlMilliseconds: number;

  public constructor(private readonly options: GoogleOAuthServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomState = options.randomState ?? createRandomState;
    this.stateTtlMilliseconds = options.stateTtlMilliseconds ?? 10 * 60 * 1_000;
  }

  public beginAuthorization(ownerId: string): GoogleAuthorizationRequest {
    const state = this.randomState();
    const now = this.now();
    this.options.stateRepository.createGoogleOAuthState({
      expiresAt: new Date(now.valueOf() + this.stateTtlMilliseconds),
      ownerId,
      state,
    });

    return {
      authorizationUrl: this.options.provider.createAuthorizationUrl(state),
      state,
    };
  }

  public async completeAuthorization(input: {
    code: string;
    state: string;
  }): Promise<{ ownerId: string }> {
    const state = this.options.stateRepository.consumeGoogleOAuthState({
      now: this.now(),
      state: input.state,
    });
    if (!state) {
      throw new OAuthStateError("Authorization link is invalid, expired, or has already been used");
    }

    const exchanged = await this.options.provider.exchangeAuthorizationCode(input.code);
    const existing = this.options.stateRepository.getGoogleOAuth();
    const refreshToken = exchanged.refreshToken ?? existing?.refreshToken;

    if (!refreshToken) {
      throw new GoogleOAuthError(
        "Google did not return a refresh token. Start the connection flow again and approve access.",
      );
    }

    this.options.stateRepository.saveGoogleOAuth({
      ...exchanged,
      refreshToken,
    });

    return { ownerId: state.ownerId };
  }
}

export type GoogleOAuthRepository = Pick<
  AppStateRepository,
  "createGoogleOAuthState" | "consumeGoogleOAuthState" | "getGoogleOAuth" | "saveGoogleOAuth"
>;
