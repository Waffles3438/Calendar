import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Logger } from "pino";

export interface OAuthCallbackHandler {
  readonly path: string;
  handle(input: {
    code?: string | undefined;
    error?: string | undefined;
    state?: string | undefined;
  }): Promise<{
    body: string;
    statusCode: number;
  }>;
}

export interface HealthServerOptions {
  readonly host: string;
  readonly isReady?: () => boolean;
  readonly logger: Logger;
  readonly oauthCallback?: OAuthCallbackHandler;
  readonly port: number;
}

export interface HealthServer {
  readonly url: string;
  close(): Promise<void>;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

function createRequestHandler(
  isReady: () => boolean,
  oauthCallback: OAuthCallbackHandler | undefined,
  logger: Logger,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response): void => {
    void handleRequest(request, response, isReady, oauthCallback, logger).catch((error: unknown) => {
      logger.error({ error }, "Unhandled health server request failure");
      if (!response.headersSent) {
        writeJson(response, 500, { error: "internal_server_error" });
      }
    });
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  isReady: () => boolean,
  oauthCallback: OAuthCallbackHandler | undefined,
  logger: Logger,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    writeJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  if (oauthCallback && url.pathname === oauthCallback.path) {
    try {
      const callbackResponse = await oauthCallback.handle({
        code: url.searchParams.get("code") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
      });
      writeHtml(response, callbackResponse.statusCode, callbackResponse.body);
    } catch (error: unknown) {
      logger.error({ error }, "OAuth callback handler failed");
      writeHtml(response, 500, "<h1>Calendar connection failed</h1>");
    }
    return;
  }

  if (url.pathname === "/healthz") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname === "/readyz") {
    const ready = isReady();
    writeJson(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen({ host, port }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
  const isReady = options.isReady ?? (() => true);
  const server = createServer(createRequestHandler(isReady, options.oauthCallback, options.logger));

  await listen(server, options.host, options.port);

  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("The health server did not provide a TCP listening address");
  }

  const { address: hostname, port } = address as AddressInfo;
  const formattedHostname = hostname.includes(":") ? `[${hostname}]` : hostname;
  const url = `http://${formattedHostname}:${port}`;

  options.logger.info({ host: options.host, port }, "Health server listening");

  return {
    close: () => close(server),
    url,
  };
}
