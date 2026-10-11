import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CalendarManagementService,
  CalendarMigrationStatus,
} from "../src/application/calendar-management-service.js";
import type { ManagedCalendar } from "../src/domain/calendar-management.js";
import { listCalendarTemplates } from "../src/domain/calendar-management.js";
import { CalendarWebApplication } from "../src/http/calendar-web.js";
import { startHealthServer, type HealthServer } from "../src/http/health-server.js";
import { createLogger } from "../src/logger.js";
import { AppStateRepository } from "../src/persistence/state-repository.js";

const ownerId = "web-owner";
const webToken = "web-access-token-".concat("x".repeat(32));
const now = new Date("2026-08-23T12:00:00.000Z");

let server: HealthServer | undefined;
let repository: AppStateRepository | undefined;
let currentNow = now;

function calendar(id: string, overrides: Partial<ManagedCalendar> = {}): ManagedCalendar {
  return {
    accessRole: "owner",
    backgroundColor: "#4EA7D7",
    canDelete: true,
    canManageEvents: true,
    canManageMetadata: true,
    foregroundColor: "#FFFFFF",
    hidden: false,
    id,
    isPrimary: false,
    readOnly: false,
    selected: true,
    summary: id,
    timeZone: "America/Toronto",
    ...overrides,
  };
}

function migrationStatus(status: "completed" | "failed" | "pending" | "running" | "cancelled", id = "migration-1"): CalendarMigrationStatus {
  return {
    events: [],
    job: {
      ...(status === "completed" ? { completedAt: now } : {}),
      ...(status === "failed" ? { failureReason: "The source calendar was kept" } : {}),
      createdAt: now,
      destinationCalendarId: "destination",
      destinationCalendarName: "Destination",
      id,
      ownerId,
      sourceCalendarId: "source",
      sourceCalendarName: "Source",
      status,
      updatedAt: now,
    },
  };
}

function fakeService() {
  return {
    createCalendar: vi.fn(async () => calendar("created", { summary: "Created" })),
    getMigrationStatus: vi.fn(() => migrationStatus("running")),
    listCalendars: vi.fn(async () => [
      calendar("source", { summary: "Source" }),
      calendar("destination", { summary: "Destination" }),
    ]),
    listTemplates: vi.fn(() => listCalendarTemplates()),
    previewCalendarDeletion: vi.fn(async () => ({
      destinations: [calendar("destination", { summary: "Destination" })],
      source: calendar("source", { summary: "Source" }),
    })),
    resumeCalendarDeletion: vi.fn(async () => migrationStatus("completed")),
    runCalendarDeletion: vi.fn(async () => migrationStatus("completed")),
    setCalendarVisibility: vi.fn(async () => calendar("source", { summary: "Source", hidden: true, selected: false })),
    startCalendarDeletion: vi.fn(async () => migrationStatus("pending")),
    updateCalendar: vi.fn(async () => calendar("source", { summary: "Updated" })),
  };
}

type FakeService = ReturnType<typeof fakeService>;

async function startWebServer(cookieSecure = false): Promise<FakeService> {
  currentNow = now;
  repository = new AppStateRepository({
    databasePath: ":memory:",
    encryptionSecret: "calendar-web-tests".repeat(3),
  });
  const service = fakeService();
  const application = new CalendarWebApplication({
    cookieSecure,
    now: () => currentNow,
    ownerId,
    service: service as unknown as CalendarManagementService,
    stateRepository: repository,
    token: webToken,
  });
  server = await startHealthServer({
    host: "127.0.0.1",
    logger: createLogger("silent"),
    port: 0,
    webApplication: application,
  });
  return service;
}

async function login(): Promise<{
  cookie: string;
  csrfToken: string;
  expiresAt: string;
  response: Response;
}> {
  if (!server) {
    throw new Error("web server is not running");
  }
  const response = await fetch(`${server.url}/api/login`, {
    body: JSON.stringify({ token: webToken }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.json() as { csrfToken: string; expiresAt: string };
  const setCookie = response.headers.get("set-cookie") ?? "";
  return {
    cookie: setCookie.split(";")[0] ?? "",
    csrfToken: body.csrfToken,
    expiresAt: body.expiresAt,
    response,
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  repository?.close();
  repository = undefined;
});

describe("CalendarWebApplication", () => {
  it("serves the screenshot-aligned static calendar page and preserves health fallback routes", async () => {
    const service = await startWebServer();

    const page = await fetch(`${server?.url}/`);
    const rootPost = await fetch(`${server?.url}/`, { method: "POST" });
    const health = await fetch(`${server?.url}/healthz`);
    const unauthenticated = await fetch(`${server?.url}/api/calendars`);
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("My calendars");
    expect(html).toContain("calendar-list");
    expect(html).toContain("#1b1b1b");
    expect(html).toContain("Add calendar");
    expect(html).toContain("Move events before deleting");
    expect(html).toContain("Resume migration");
    expect(html).toContain("/api/calendars");
    expect(html).not.toContain(webToken);
    expect(rootPost.status).toBe(405);
    expect(rootPost.headers.get("allow")).toBe("GET");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(unauthenticated.status).toBe(401);
    expect(service.listCalendars).not.toHaveBeenCalled();
  });

  it("validates login bodies, creates hashed owner-bound sessions, and applies cookie security", async () => {
    await startWebServer();

    const wrongMethod = await fetch(`${server?.url}/api/login`, { method: "GET" });
    const malformed = await fetch(`${server?.url}/api/login`, {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const invalid = await fetch(`${server?.url}/api/login`, {
      body: JSON.stringify({ token: "wrong-token" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const session = await login();

    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: "invalid_json_body" });
    expect(invalid.status).toBe(401);
    expect(session.response.status).toBe(200);
    expect(session.response.headers.get("set-cookie")).toMatch(/calendar_session=.*HttpOnly; SameSite=Lax; Max-Age=28800/u);
    expect(session.response.headers.get("set-cookie")).not.toContain("Secure");
    expect(session.csrfToken).toHaveLength(43);
    expect(repository).toBeDefined();
    const token = session.cookie.slice("calendar_session=".length);
    const stored = repository?.getWebSession({ now, token });
    expect(stored?.ownerId).toBe(ownerId);
    expect(stored?.csrfTokenHash).toBe(createHash("sha256").update(session.csrfToken).digest("base64url"));
    expect(stored?.csrfTokenHash).not.toBe(session.csrfToken);
  });

  it("adds Secure to production-style session cookies", async () => {
    await startWebServer(true);

    const session = await login();

    expect(session.response.headers.get("set-cookie")).toContain("; Secure");
  });

  it("enforces sessions and CSRF while routing calendar CRUD and migration operations", async () => {
    const service = await startWebServer();
    const unauthenticated = await fetch(`${server?.url}/api/templates`);
    const session = await login();
    service.createCalendar.mockClear();
    service.listCalendars.mockClear();

    const templates = await fetch(`${server?.url}/api/templates`, { headers: { cookie: session.cookie } });
    const calendars = await fetch(`${server?.url}/api/calendars`, { headers: { cookie: session.cookie } });
    const csrfFailure = await fetch(`${server?.url}/api/calendars`, {
      body: JSON.stringify({ csrfToken: "wrong", name: "Ignored" }),
      headers: { cookie: session.cookie, "content-type": "application/json" },
      method: "POST",
    });
    const createCallsAfterCsrfFailure = service.createCalendar.mock.calls.length;
    const created = await fetch(`${server?.url}/api/calendars`, {
      body: JSON.stringify({
        color: "#abcdef",
        csrfToken: session.csrfToken,
        description: "Description",
        ignored: "not forwarded",
        name: "Created",
        templateId: "classes",
      }),
      headers: { cookie: session.cookie, "content-type": "application/json" },
      method: "POST",
    });
    const updated = await fetch(`${server?.url}/api/calendars/${encodeURIComponent("source/calendar")}`, {
      body: JSON.stringify({ color: "#ffffff", csrfToken: session.csrfToken, description: "Updated", name: "Renamed" }),
      headers: { cookie: session.cookie, "content-type": "application/json" },
      method: "PATCH",
    });
    const visibility = await fetch(`${server?.url}/api/calendars/source/visibility`, {
      body: JSON.stringify({ csrfToken: session.csrfToken, hidden: true, selected: false }),
      headers: { cookie: session.cookie, "content-type": "application/json" },
      method: "PATCH",
    });
    const preview = await fetch(`${server?.url}/api/calendars/source/delete-preview`, {
      headers: { cookie: session.cookie },
    });
    const missingDestination = await fetch(`${server?.url}/api/calendars/source/delete`, {
      body: JSON.stringify({ csrfToken: session.csrfToken }),
      headers: { cookie: session.cookie, "content-type": "application/json" },
      method: "POST",
    });
    const deletion = await fetch(`${server?.url}/api/calendars/source/delete`, {
      body: JSON.stringify({ csrfToken: session.csrfToken, destinationCalendarId: "destination" }),
      headers: { cookie: session.cookie, "content-type": "application/json" },
      method: "POST",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const migration = await fetch(`${server?.url}/api/migrations/migration-1`, {
      headers: { cookie: session.cookie },
    });
    const resumeFailure = await fetch(`${server?.url}/api/migrations/migration-1/resume`, {
      body: JSON.stringify({ csrfToken: "wrong" }),
      headers: { cookie: session.cookie, "content-type": "application/json" },
      method: "POST",
    });
    const resume = await fetch(`${server?.url}/api/migrations/migration-1/resume`, {
      body: JSON.stringify({ csrfToken: session.csrfToken }),
      headers: { cookie: session.cookie, "content-type": "application/json" },
      method: "POST",
    });

    expect(unauthenticated.status).toBe(401);
    expect(templates.status).toBe(200);
    expect((await json(templates)).templates).toHaveLength(6);
    expect(calendars.status).toBe(200);
    expect((await json(calendars)).calendars).toHaveLength(2);
    expect(csrfFailure.status).toBe(403);
    expect(createCallsAfterCsrfFailure).toBe(0);
    expect(created.status).toBe(201);
    expect(service.createCalendar).toHaveBeenCalledWith({
      color: "#abcdef",
      description: "Description",
      name: "Created",
      templateId: "classes",
    });
    expect(updated.status).toBe(200);
    expect(service.updateCalendar).toHaveBeenCalledWith("source/calendar", {
      color: "#ffffff",
      description: "Updated",
      name: "Renamed",
    });
    expect(visibility.status).toBe(200);
    expect(service.setCalendarVisibility).toHaveBeenCalledWith("source", { hidden: true, selected: false });
    expect(preview.status).toBe(200);
    expect(service.previewCalendarDeletion).toHaveBeenCalledWith("source");
    expect(missingDestination.status).toBe(400);
    expect(deletion.status).toBe(202);
    expect(service.startCalendarDeletion).toHaveBeenCalledWith({
      destinationCalendarId: "destination",
      sourceCalendarId: "source",
    });
    expect(service.runCalendarDeletion).toHaveBeenCalledWith("migration-1");
    expect(migration.status).toBe(200);
    expect(resumeFailure.status).toBe(403);
    expect(resume.status).toBe(202);
    expect(service.resumeCalendarDeletion).toHaveBeenCalledWith("migration-1");
  });

  it("rejects expired, wrong-owner, and malformed-cookie sessions, then logs out cleanly", async () => {
    const service = await startWebServer();
    const session = await login();
    currentNow = new Date(session.expiresAt);

    const expired = await fetch(`${server?.url}/api/calendars`, { headers: { cookie: session.cookie } });
    expect(expired.status).toBe(401);
    expect(service.listCalendars).not.toHaveBeenCalled();

    currentNow = now;
    repository?.createWebSession({
      createdAt: now,
      csrfToken: "other-csrf-token",
      expiresAt: new Date(now.valueOf() + 60_000),
      ownerId: "different-owner",
      token: "other-session-token",
    });
    const wrongOwner = await fetch(`${server?.url}/api/templates`, {
      headers: { cookie: "calendar_session=other-session-token" },
    });
    const malformedCookie = await fetch(`${server?.url}/api/templates`, {
      headers: { cookie: "calendar_session=%E0%A4%A" },
    });
    const logout = await fetch(`${server?.url}/api/logout`, {
      headers: { cookie: session.cookie },
      method: "POST",
    });
    const afterLogout = await fetch(`${server?.url}/api/templates`, { headers: { cookie: session.cookie } });

    expect(wrongOwner.status).toBe(401);
    expect(malformedCookie.status).toBe(401);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(afterLogout.status).toBe(401);
  });

  it("returns 400 for malformed authenticated bodies and 404 for authenticated unknown routes", async () => {
    await startWebServer();
    const session = await login();

    const malformed = await fetch(`${server?.url}/api/calendars`, {
      body: "[]",
      headers: { cookie: session.cookie, "content-type": "application/json" },
      method: "POST",
    });
    const unknown = await fetch(`${server?.url}/api/unknown`, { headers: { cookie: session.cookie } });
    const unknownMethod = await fetch(`${server?.url}/api/calendars`, {
      headers: { cookie: session.cookie },
      method: "PUT",
    });

    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_json_body" });
    expect(unknown.status).toBe(404);
    expect(unknownMethod.status).toBe(404);
  });
});
