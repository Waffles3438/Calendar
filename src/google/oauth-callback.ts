import type { Logger } from "pino";

import type { OAuthCallbackHandler } from "../http/health-server.js";
import type { GoogleOAuthService } from "./oauth-service.js";

export interface GoogleOAuthCallbackHandlerOptions {
  readonly logger: Logger;
  readonly onAuthorized?: (ownerId: string) => Promise<void> | void;
  readonly oauthService: Pick<GoogleOAuthService, "completeAuthorization">;
  readonly path?: string;
}

const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Calendar connected</title></head><body><h1>Google Calendar connected</h1><p>You can close this tab and return to Discord.</p></body></html>`;
const FAILURE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Calendar connection failed</title></head><body><h1>Calendar connection failed</h1><p>Return to Discord and send /connect to try again.</p></body></html>`;

/** Converts a Google browser redirect into a validated OAuth completion. */
export class GoogleOAuthCallbackHandler implements OAuthCallbackHandler {
  public readonly path: string;

  public constructor(private readonly options: GoogleOAuthCallbackHandlerOptions) {
    this.path = options.path ?? "/oauth/google/callback";
  }

  public async handle(input: {
    code?: string | undefined;
    error?: string | undefined;
    state?: string | undefined;
  }): Promise<{ body: string; statusCode: number }> {
    if (input.error || !input.code || !input.state) {
      return { body: FAILURE_PAGE, statusCode: 400 };
    }

    try {
      const result = await this.options.oauthService.completeAuthorization({
        code: input.code,
        state: input.state,
      });
      await this.options.onAuthorized?.(result.ownerId);
      return { body: SUCCESS_PAGE, statusCode: 200 };
    } catch (error: unknown) {
      this.options.logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Google OAuth callback was rejected",
      );
      return { body: FAILURE_PAGE, statusCode: 400 };
    }
  }
}
