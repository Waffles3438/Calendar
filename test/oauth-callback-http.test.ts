import { afterEach, describe, expect, it } from "vitest";

import {
  startHealthServer,
  type HealthServer,
  type OAuthCallbackHandler,
} from "../src/http/health-server.js";
import { createLogger } from "../src/logger.js";

describe("OAuth callback HTTP endpoint", () => {
  let server: HealthServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("routes the configured callback path and keeps unrelated paths hidden", async () => {
    const received: unknown[] = [];
    const callback: OAuthCallbackHandler = {
      handle: async (input) => {
        received.push(input);
        return {
          body: "<h1>Connected</h1>",
          statusCode: 200,
        };
      },
      path: "/oauth/google/callback",
    };

    server = await startHealthServer({
      host: "127.0.0.1",
      logger: createLogger("silent"),
      oauthCallback: callback,
      port: 0,
    });

    const callbackResponse = await fetch(
      `${server.url}/oauth/google/callback?code=abc&state=state-123`,
    );
    const unknownResponse = await fetch(`${server.url}/oauth/unknown`);

    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.headers.get("content-type")).toContain("text/html");
    await expect(callbackResponse.text()).resolves.toContain("Connected");
    expect(received).toEqual([{ code: "abc", error: undefined, state: "state-123" }]);
    expect(unknownResponse.status).toBe(404);
  });
});
