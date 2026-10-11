import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  CalendarManagementService,
  CalendarMigrationStatus,
} from "../application/calendar-management-service.js";
import type { CalendarTemplateInput } from "../domain/calendar-management.js";
import type { WebSession } from "../persistence/state-repository.js";

export interface CalendarWebStateRepository {
  clearExpiredWebSessions(now: Date): void;
  createWebSession(input: {
    createdAt: Date;
    csrfToken: string;
    expiresAt: Date;
    ownerId: string;
    token: string;
  }): void;
  deleteWebSession(token: string): void;
  getWebSession(input: { now: Date; token: string }): WebSession | undefined;
}

export interface CalendarWebApplicationOptions {
  readonly cookieSecure?: boolean;
  readonly now?: () => Date;
  readonly ownerId: string;
  readonly service: CalendarManagementService;
  readonly stateRepository: CalendarWebStateRepository;
  readonly token: string;
  readonly sessionTtlMilliseconds?: number;
}

export interface HttpApplication {
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
}

const SESSION_COOKIE = "calendar_session";
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_SESSION_TTL = 8 * 60 * 60 * 1_000;

export class CalendarWebApplication implements HttpApplication {
  private readonly cookieSecure: boolean;
  private readonly now: () => Date;
  private readonly sessionTtlMilliseconds: number;

  public constructor(private readonly options: CalendarWebApplicationOptions) {
    this.cookieSecure = options.cookieSecure ?? false;
    this.now = options.now ?? (() => new Date());
    this.sessionTtlMilliseconds = options.sessionTtlMilliseconds ?? DEFAULT_SESSION_TTL;
  }

  public async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        writeJson(response, 405, { error: "method_not_allowed" });
        return true;
      }
      writeHtml(response, 200, CALENDAR_PAGE);
      return true;
    }

    if (!url.pathname.startsWith("/api/")) {
      return false;
    }

    if (url.pathname === "/api/login") {
      await this.handleLogin(request, response);
      return true;
    }
    if (url.pathname === "/api/logout") {
      await this.handleLogout(request, response);
      return true;
    }

    const session = this.authenticate(request, response);
    if (!session) {
      return true;
    }

    if (url.pathname === "/api/templates" && request.method === "GET") {
      writeJson(response, 200, { templates: this.options.service.listTemplates() });
      return true;
    }
    if (url.pathname === "/api/calendars" && request.method === "GET") {
      const calendars = await this.options.service.listCalendars();
      writeJson(response, 200, { calendars });
      return true;
    }
    if (url.pathname === "/api/calendars" && request.method === "POST") {
      const body = await this.readBody(request, response);
      if (!body) {
        return true;
      }
      if (!this.requireCsrf(body.csrfToken, session, response)) {
        return true;
      }
      const created = await this.options.service.createCalendar(toTemplateInput(body));
      writeJson(response, 201, { calendar: created });
      return true;
    }

    const calendarMatch = /^\/api\/calendars\/([^/]+)$/.exec(url.pathname);
    if (calendarMatch?.[1] && request.method === "PATCH") {
      const body = await this.readBody(request, response);
      if (!body || !this.requireCsrf(body.csrfToken, session, response)) {
        return true;
      }
      const updated = await this.options.service.updateCalendar(decodeURIComponent(calendarMatch[1]), {
        ...(typeof body.color === "string" ? { color: body.color } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
      });
      writeJson(response, 200, { calendar: updated });
      return true;
    }

    const visibilityMatch = /^\/api\/calendars\/([^/]+)\/visibility$/.exec(url.pathname);
    if (visibilityMatch?.[1] && request.method === "PATCH") {
      const body = await this.readBody(request, response);
      if (!body || !this.requireCsrf(body.csrfToken, session, response)) {
        return true;
      }
      const updated = await this.options.service.setCalendarVisibility(decodeURIComponent(visibilityMatch[1]), {
        ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}),
        ...(typeof body.selected === "boolean" ? { selected: body.selected } : {}),
      });
      writeJson(response, 200, { calendar: updated });
      return true;
    }

    const previewMatch = /^\/api\/calendars\/([^/]+)\/delete-preview$/.exec(url.pathname);
    if (previewMatch?.[1] && request.method === "GET") {
      const preview = await this.options.service.previewCalendarDeletion(decodeURIComponent(previewMatch[1]));
      writeJson(response, 200, preview);
      return true;
    }

    const deleteMatch = /^\/api\/calendars\/([^/]+)\/delete$/.exec(url.pathname);
    if (deleteMatch?.[1] && request.method === "POST") {
      const body = await this.readBody(request, response);
      if (!body || !this.requireCsrf(body.csrfToken, session, response)) {
        return true;
      }
      if (typeof body.destinationCalendarId !== "string") {
        writeJson(response, 400, { error: "destination_calendar_required" });
        return true;
      }
      const status = await this.options.service.startCalendarDeletion({
        destinationCalendarId: body.destinationCalendarId,
        sourceCalendarId: decodeURIComponent(deleteMatch[1]),
      });
      void this.options.service.runCalendarDeletion(status.job.id);
      writeJson(response, 202, status);
      return true;
    }

    const migrationMatch = /^\/api\/migrations\/([^/]+)$/.exec(url.pathname);
    if (migrationMatch?.[1] && request.method === "GET") {
      writeJson(response, 200, this.options.service.getMigrationStatus(decodeURIComponent(migrationMatch[1])));
      return true;
    }

    const resumeMatch = /^\/api\/migrations\/([^/]+)\/resume$/.exec(url.pathname);
    if (resumeMatch?.[1] && request.method === "POST") {
      const body = await this.readBody(request, response);
      if (!body || !this.requireCsrf(body.csrfToken, session, response)) {
        return true;
      }
      writeJson(response, 202, await this.options.service.resumeCalendarDeletion(decodeURIComponent(resumeMatch[1])));
      return true;
    }

    writeJson(response, 404, { error: "not_found" });
    return true;
  }

  private async handleLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    const body = await this.readBody(request, response);
    if (!body) {
      return;
    }
    if (typeof body.token !== "string" || !secureEquals(this.options.token, body.token)) {
      writeJson(response, 401, { error: "invalid_credentials" });
      return;
    }

    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    this.options.stateRepository.clearExpiredWebSessions(now);
    this.options.stateRepository.createWebSession({
      createdAt: now,
      csrfToken,
      expiresAt: new Date(now.valueOf() + this.sessionTtlMilliseconds),
      ownerId: this.options.ownerId,
      token,
    });
    response.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.sessionTtlMilliseconds / 1_000)}${this.cookieSecure ? "; Secure" : ""}`);
    writeJson(response, 200, { csrfToken, expiresAt: new Date(now.valueOf() + this.sessionTtlMilliseconds).toISOString() });
  }

  private async handleLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token) {
      this.options.stateRepository.deleteWebSession(token);
    }
    response.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.cookieSecure ? "; Secure" : ""}`);
    writeJson(response, 200, { ok: true });
  }

  private authenticate(request: IncomingMessage, response: ServerResponse): WebSession | undefined {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    const session = token ? this.options.stateRepository.getWebSession({ now: this.now(), token }) : undefined;
    if (!session || session.ownerId !== this.options.ownerId) {
      writeJson(response, 401, { error: "authentication_required" });
      return undefined;
    }
    return session;
  }

  private requireCsrf(value: unknown, session: WebSession, response: ServerResponse): boolean {
    if (typeof value !== "string" || !secureEqualsHash(session.csrfTokenHash, value)) {
      writeJson(response, 403, { error: "csrf_failed" });
      return false;
    }
    return true;
  }

  private async readBody(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | undefined> {
    try {
      const raw = await readRequestBody(request);
      if (!raw) {
        return {};
      }
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        writeJson(response, 400, { error: "invalid_json_body" });
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch (error: unknown) {
      writeJson(response, error instanceof RequestBodyTooLargeError ? 413 : 400, {
        error: error instanceof RequestBodyTooLargeError ? "request_body_too_large" : "invalid_json_body",
      });
      return undefined;
    }
  }
}

function toTemplateInput(body: Record<string, unknown>): CalendarTemplateInput {
  return {
    ...(typeof body.color === "string" ? { color: body.color } : {}),
    ...(typeof body.description === "string" ? { description: body.description } : {}),
    ...(typeof body.name === "string" ? { name: body.name } : {}),
    ...(typeof body.templateId === "string" ? { templateId: body.templateId } : {}),
  };
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

function readCookie(header: string | undefined, name: string): string | undefined {
  const value = header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!value) {
    return undefined;
  }
  try {
    return decodeURIComponent(value.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

function secureEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function secureEqualsHash(expectedHash: string, actual: string): boolean {
  const actualHash = createHash("sha256").update(actual, "utf8").digest("base64url");
  return secureEquals(expectedHash, actualHash);
}

class RequestBodyTooLargeError extends Error { }

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RequestBodyTooLargeError());
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const CALENDAR_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calendar management</title>
<style>
:root{color-scheme:dark;font-family:Arial,ui-sans-serif,system-ui,sans-serif;background:#181818;color:#f3f3f3}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#181818}.shell{display:flex;min-height:100vh}.sidebar{width:278px;padding:18px 16px;background:#1b1b1b}.brand{display:flex;align-items:center;justify-content:space-between;margin:0 0 24px;font-size:20px;font-weight:700}.brand button{border:0;background:transparent;color:#ddd;font-size:0;width:22px;height:22px;position:relative;cursor:pointer}.brand button:before,.brand button:after{content:"";position:absolute;top:9px;width:11px;height:2px;background:#ddd}.brand button:before{left:1px;transform:rotate(-45deg)}.brand button:after{right:1px;transform:rotate(45deg)}.calendar-list{list-style:none;margin:0;padding:0}.calendar-row{display:flex;align-items:center;gap:16px;min-height:42px;padding:4px 0}.calendar-row input{appearance:none;width:23px;height:23px;border-radius:2px;margin:0;position:relative;cursor:pointer}.calendar-row input:checked:after{content:"✓";position:absolute;color:#111;font-size:20px;line-height:23px;left:3px;top:-1px}.calendar-name{font-size:19px;letter-spacing:.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.calendar-actions{margin-left:auto;display:flex;gap:5px;opacity:.25}.calendar-row:hover .calendar-actions{opacity:1}.calendar-actions button,.add-button,button{border:1px solid #505050;background:#282828;color:#f3f3f3;border-radius:5px;padding:7px 10px;cursor:pointer}.calendar-actions button{font-size:12px;padding:4px 7px}.add-button{width:100%;margin-top:20px;text-align:left;background:#222;border-color:#666}.content{flex:1;padding:38px;max-width:820px}.panel{background:#222;border:1px solid #444;border-radius:10px;padding:22px;margin-bottom:18px}.panel h2{margin:0 0 16px;font-size:20px}.field{display:grid;gap:7px;margin:12px 0}.field label{font-size:13px;color:#c8c8c8}.field input,.field textarea,.field select{width:100%;padding:10px;border-radius:5px;border:1px solid #555;background:#151515;color:#fff;font:inherit}.field textarea{min-height:80px;resize:vertical}.actions{display:flex;gap:8px;margin-top:18px}.primary{background:#4ca3d5;border-color:#4ca3d5;color:#101010;font-weight:700}.muted{color:#aaa;font-size:13px}.hidden{display:none!important}.error{color:#ff9c9c;margin-top:10px}.login{max-width:430px;margin:15vh auto}.status{margin:0 0 16px;color:#b7e3ff}.danger{border-color:#9b5757}.danger button{background:#542c2c;border-color:#9b5757}.badge{font-size:11px;color:#aaa;margin-left:8px}
</style>
</head>
<body>
<div id="login" class="panel login"><h2>Calendar management</h2><p class="muted">Sign in to manage your Google calendars.</p><form id="login-form"><div class="field"><label for="access-token">Web access token</label><input id="access-token" type="password" autocomplete="current-password" required></div><button class="primary" type="submit">Sign in</button></form><p id="login-error" class="error hidden"></p></div>
<div id="app" class="shell hidden"><aside class="sidebar"><h1 class="brand">My calendars <button id="collapse" aria-label="Collapse calendar list">⌃</button></h1><ul id="calendar-list" class="calendar-list"></ul><button id="add-button" class="add-button">＋ Add calendar</button><button id="logout" class="add-button">Sign out</button></aside><main class="content"><p id="status" class="status"></p><button id="resume-migration" class="hidden">Resume migration</button><section id="add-panel" class="panel hidden"><h2>Add calendar</h2><form id="add-form"><div class="field"><label for="template">Template</label><select id="template"></select></div><div class="field"><label for="calendar-name">Name</label><input id="calendar-name" maxlength="160" required></div><div class="field"><label for="calendar-color">Color</label><input id="calendar-color" type="color" value="#4EA7D7"></div><div class="field"><label for="calendar-description">Description</label><textarea id="calendar-description" maxlength="2000"></textarea></div><div class="actions"><button class="primary" type="submit">Create calendar</button><button id="cancel-add" type="button">Cancel</button></div></form></section><section id="edit-panel" class="panel hidden"><h2>Edit calendar</h2><form id="edit-form"><input id="edit-id" type="hidden"><div class="field"><label for="edit-name">Name</label><input id="edit-name" maxlength="160" required></div><div class="field"><label for="edit-color">Color</label><input id="edit-color" type="color"></div><div class="field"><label for="edit-description">Description</label><textarea id="edit-description" maxlength="2000"></textarea></div><div class="actions"><button class="primary" type="submit">Save changes</button><button id="cancel-edit" type="button">Cancel</button></div></form></section><section id="delete-panel" class="panel danger hidden"><h2>Move events before deleting</h2><p id="delete-copy" class="muted"></p><form id="delete-form"><input id="delete-id" type="hidden"><div class="field"><label for="destination">Destination calendar</label><select id="destination" required></select></div><div class="actions"><button type="submit">Move events and delete</button><button id="cancel-delete" type="button">Cancel</button></div></form></section><section id="login-hint" class="panel"><h2>Calendar controls</h2><p class="muted">Select a calendar to show or hide it. Use Edit for metadata and Delete to migrate its events to another existing calendar first.</p></section></main></div>
<script>
(() => {
  let csrfToken = '';
  let migrationId = '';
  const $ = (id) => document.getElementById(id);
  const json = async (url, options = {}) => { const response = await fetch(url, { headers: {'content-type':'application/json', ...(options.headers || {})}, ...options }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || 'Request failed'); return body; };
  const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
  const setStatus = (text, error = false) => { $('status').textContent = text; $('status').style.color = error ? '#ff9c9c' : '#b7e3ff'; };
  const resetPanels = () => { show('add-panel', false); show('edit-panel', false); show('delete-panel', false); };
  const showResume = (id, visible) => { migrationId = visible ? id : ''; show('resume-migration', visible); };
  const pollMigration = async (id) => { try { const current = await json('/api/migrations/' + encodeURIComponent(id)); if (current.job.status === 'completed') { showResume('', false); setStatus('Calendar deleted and events migrated.'); await refresh(); return; } if (current.job.status === 'failed') { showResume(id, true); setStatus(current.job.failureReason || 'Migration failed; the source calendar was kept.', true); return; } if (current.job.status === 'cancelled') { showResume('', false); setStatus('Migration cancelled.', true); return; } setTimeout(() => { void pollMigration(id); }, 1000); } catch (error) { showResume('', false); setStatus(error.message || 'Could not read migration status.', true); } };
  const refresh = async () => { const body = await json('/api/calendars'); const list = $('calendar-list'); list.replaceChildren(); body.calendars.forEach((calendar) => { const row = document.createElement('li'); row.className = 'calendar-row'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = calendar.selected && !calendar.hidden; checkbox.disabled = !calendar.canManageMetadata; checkbox.style.background = calendar.backgroundColor || '#777'; checkbox.addEventListener('change', async () => { try { await json('/api/calendars/' + encodeURIComponent(calendar.id) + '/visibility', {method:'PATCH', body:JSON.stringify({csrfToken, hidden:!checkbox.checked, selected:checkbox.checked})}); setStatus('Calendar visibility updated.'); } catch (error) { checkbox.checked = !checkbox.checked; setStatus(error.message, true); } }); const name = document.createElement('span'); name.className = 'calendar-name'; name.textContent = calendar.summary; if (calendar.isPrimary) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'primary'; name.appendChild(badge); } if (calendar.readOnly) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'read-only'; name.appendChild(badge); } const actions = document.createElement('span'); actions.className = 'calendar-actions'; if (calendar.canManageMetadata) { const edit = document.createElement('button'); edit.textContent = 'Edit'; edit.addEventListener('click', () => openEdit(calendar)); actions.appendChild(edit); } if (calendar.canDelete) { const remove = document.createElement('button'); remove.textContent = 'Delete'; remove.addEventListener('click', () => openDelete(calendar)); actions.appendChild(remove); } row.append(checkbox, name, actions); list.appendChild(row); }); setStatus(body.calendars.length ? '' : 'No calendars found.'); };
  const openEdit = (calendar) => { resetPanels(); $('edit-id').value = calendar.id; $('edit-name').value = calendar.summary; $('edit-color').value = calendar.backgroundColor || '#4EA7D7'; $('edit-description').value = calendar.description || ''; show('edit-panel', true); };
  const openDelete = async (calendar) => { try { const preview = await json('/api/calendars/' + encodeURIComponent(calendar.id) + '/delete-preview'); $('delete-id').value = calendar.id; $('delete-copy').textContent = 'Events in ' + calendar.summary + ' will be moved before the source calendar is deleted. Choose one of the existing calendars below.'; const select = $('destination'); select.replaceChildren(); preview.destinations.forEach((destination) => { const option = document.createElement('option'); option.value = destination.id; option.textContent = destination.summary; select.appendChild(option); }); resetPanels(); show('delete-panel', true); } catch (error) { setStatus(error.message, true); } };
  $('login-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await json('/api/login', {method:'POST', body:JSON.stringify({token:$('access-token').value})}); csrfToken = result.csrfToken; show('login', false); show('app', true); await loadTemplates(); await refresh(); } catch (error) { $('login-error').textContent = error.message; show('login-error', true); } });
  const loadTemplates = async () => { const result = await json('/api/templates'); const select = $('template'); select.replaceChildren(); result.templates.forEach((template) => { const option = document.createElement('option'); option.value = template.id; option.textContent = template.name; select.appendChild(option); }); select.value = 'benny-wang'; applyTemplate(); };
  const applyTemplate = async () => { const result = await json('/api/templates'); const template = result.templates.find((item) => item.id === $('template').value) || result.templates[0]; if (template) { $('calendar-name').value = template.name; $('calendar-color').value = template.color; $('calendar-description').value = template.description; } };
  $('template').addEventListener('change', applyTemplate); $('add-button').addEventListener('click', () => { resetPanels(); show('add-panel', true); applyTemplate(); }); $('cancel-add').addEventListener('click', resetPanels); $('cancel-edit').addEventListener('click', resetPanels); $('cancel-delete').addEventListener('click', resetPanels); $('collapse').addEventListener('click', () => $('calendar-list').classList.toggle('hidden')); $('resume-migration').addEventListener('click', async () => { if (!migrationId) return; try { const result = await json('/api/migrations/' + encodeURIComponent(migrationId) + '/resume', {method:'POST', body:JSON.stringify({csrfToken})}); setStatus('Migration resumed.'); await pollMigration(result.job.id); } catch (error) { setStatus(error.message || 'Could not resume migration.', true); } });
  $('add-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await json('/api/calendars', {method:'POST', body:JSON.stringify({csrfToken, templateId:$('template').value, name:$('calendar-name').value, color:$('calendar-color').value, description:$('calendar-description').value})}); resetPanels(); await refresh(); setStatus('Calendar created.'); } catch (error) { setStatus(error.message, true); } });
  $('edit-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await json('/api/calendars/' + encodeURIComponent($('edit-id').value), {method:'PATCH', body:JSON.stringify({csrfToken, name:$('edit-name').value, color:$('edit-color').value, description:$('edit-description').value})}); resetPanels(); await refresh(); setStatus('Calendar updated.'); } catch (error) { setStatus(error.message, true); } });
  $('delete-form').addEventListener('submit', async (event) => { event.preventDefault(); try { const result = await json('/api/calendars/' + encodeURIComponent($('delete-id').value) + '/delete', {method:'POST', body:JSON.stringify({csrfToken, destinationCalendarId:$('destination').value})}); resetPanels(); setStatus('Migration started.'); await pollMigration(result.job.id); } catch (error) { setStatus(error.message, true); } });
  $('logout').addEventListener('click', async () => { await json('/api/logout', {method:'POST'}).catch(() => undefined); location.reload(); });
})();
</script>
</body></html>`;
