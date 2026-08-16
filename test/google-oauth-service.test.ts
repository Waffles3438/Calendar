import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GoogleOAuthService,
  OAuthStateError,
  type GoogleOAuthProvider,
} from "../src/google/oauth-service.js";
import { AppStateRepository } from "../src/persistence/state-repository.js";

const now = new Date("2026-08-15T12:00:00.000Z");

describe("GoogleOAuthService", () => {
  let directory: string | undefined;
  let repository: AppStateRepository | undefined;

  afterEach(async () => {
    repository?.close();
    repository = undefined;
    if (directory) {
      await rm(directory, { force: true, recursive: true });
      directory = undefined;
    }
  });

  async function createRepository(): Promise<AppStateRepository> {
    directory = await mkdtemp(join(tmpdir(), "calendar-oauth-"));
    repository = new AppStateRepository({
      databasePath: join(directory, "calendar.sqlite"),
      encryptionSecret: "x".repeat(48),
    });
    return repository;
  }

  it("creates a one-time state token and stores credentials after a valid callback", async () => {
    const state = await createRepository();
    const provider: GoogleOAuthProvider = {
      createAuthorizationUrl: (oauthState) => `https://accounts.example.test/auth?state=${oauthState}`,
      exchangeAuthorizationCode: async () => ({
        accessToken: "access-token",
        expiresAt: "2026-08-15T13:00:00.000Z",
        refreshToken: "refresh-token",
        scope: "https://www.googleapis.com/auth/calendar.events",
      }),
    };
    const service = new GoogleOAuthService({
      now: () => now,
      provider,
      randomState: () => "secure-state",
      stateRepository: state,
    });

    const authorization = service.beginAuthorization("123456789012345678");
    expect(authorization).toEqual({
      authorizationUrl: "https://accounts.example.test/auth?state=secure-state",
      state: "secure-state",
    });

    await expect(
      service.completeAuthorization({ code: "authorization-code", state: authorization.state }),
    ).resolves.toEqual({ ownerId: "123456789012345678" });
    expect(state.getGoogleOAuth()).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });

    await expect(
      service.completeAuthorization({ code: "authorization-code", state: authorization.state }),
    ).rejects.toBeInstanceOf(OAuthStateError);
  });

  it("rejects a callback that cannot provide or preserve a refresh token", async () => {
    const state = await createRepository();
    const provider: GoogleOAuthProvider = {
      createAuthorizationUrl: (oauthState) => oauthState,
      exchangeAuthorizationCode: async () => ({ accessToken: "access-token" }),
    };
    const service = new GoogleOAuthService({
      now: () => now,
      provider,
      randomState: () => "state-without-refresh-token",
      stateRepository: state,
    });

    const authorization = service.beginAuthorization("123456789012345678");
    await expect(
      service.completeAuthorization({ code: "authorization-code", state: authorization.state }),
    ).rejects.toThrow(/refresh token/i);
  });
});
