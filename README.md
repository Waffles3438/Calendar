# Discord Calendar and Task Assistant

A single-owner Discord DM bot for private local tasks and optional Google Calendar access. Local tasks are stored encrypted in SQLite, use a configured IANA time zone (default `America/Toronto`), and can repeat reminder DMs until completed or cancelled. Common commands use deterministic parsing; an optional Gemini fallback handles unsupported wording without receiving task rows, calendar events, OAuth credentials, Discord metadata, or execution access.

## Operating model

- **One person, direct messages only.** The bot ignores guild messages, bot messages, and DMs from everyone except `DISCORD_OWNER_ID`.
- **Local tasks work without Google.** Configure Discord, the owner ID, and `ENCRYPTION_KEY` to use tasks even if Google is unconfigured, disconnected, or unavailable.
- **Safe writes.** Ambiguous task matches, calendar writes with meaningful impact, and every Gemini-proposed mutation require a one-time `confirm <id>` reply. `cancel <id>` stops a pending action.
- **Least-privilege Google access.** When enabled, the app requests `calendar.events` plus read-only calendar-list access; it does not use a service account.
- **Optional hosted AI.** Gemini is disabled unless both Gemini variables are configured. Deterministic task/calendar parsing and reminders work without it.

## Local tasks

Use local task commands in an owner DM. They never create a Google Calendar event or Google Tasks item.

| Command | Result |
|---|---|
| `remind me at 6pm tomorrow to run` | Creates a task due at the supplied Toronto local time. |
| `create task pay hydro Friday at noon` | Creates a task using canonical task wording. |
| `tasks` or `list tasks` | Lists active tasks in due-time order. |
| `done run` or `complete task run` | Completes one clear active match; multiple matches produce `choose <id> <number>`. |
| `cancel task run tomorrow` | Cancels a local task without affecting a Google Calendar event. |

A task must include a title, a supplied date expression (`tomorrow`, a weekday, or `YYYY-MM-DD`), and a time. The bot does not guess a date for a time-only request. It rejects nonexistent or ambiguous Toronto daylight-saving wall times rather than silently changing the reminder instant.

A task has nine scheduled reminder slots: at its due time and every 15 minutes through two hours afterward. Before sending a slot, the scheduler takes a durable claim and records the delivery after Discord accepts it, so overlapping workers sharing one SQLite database do not send the same live slot. Delivery is at-least-once, not exactly-once: a process crash or lease expiry after Discord accepts a DM but before durable completion can retry that slot. Completing or cancelling a task stops future slots. After downtime, the scheduler sends only the newest eligible missed slot inside that original two-hour window; it never sends a burst of old reminders. Recurring tasks, snooze, rescheduling, and task editing are intentionally out of scope in this version; recurring wording receives a clear unsupported response.

## Requirements

- Node.js **22.15.0 through 22.x** and npm 11.11.0 (see `package.json`).
- A Discord application with a bot token, the owner’s Discord user ID, and an encryption key.
- Optional: a Google Cloud OAuth client for Google Calendar access, with a public HTTPS callback URL.
- Optional: a Gemini API key and supported model identifier for unsupported task/calendar wording.
- For production: one Linux host with systemd, persistent writable storage for SQLite, and a TLS reverse proxy when Google OAuth is enabled. The service itself is plain HTTP only.

## Quick start

1. Install dependencies and validate the checkout:

   ```sh
   npm ci
   npm run check
   npm test
   npm run build
   ```

2. Copy `.env.example` to `.env`, configure `DISCORD_BOT_TOKEN`, `DISCORD_OWNER_ID`, and `ENCRYPTION_KEY`, then generate a durable encryption secret. Google and Gemini settings are optional. For example:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

   Keep that value private and unchanged. Changing it makes encrypted OAuth credentials, local task titles, and pending actions unreadable.

3. For a local run, load the file explicitly—this application does **not** load `.env` itself:

   ```sh
   node --env-file=.env dist/index.js
   ```

   `npm start` runs `node dist/index.js` and expects the environment to already be set. For a systemd deployment, use the included `EnvironmentFile` configuration instead.

4. Confirm the listener is running:

   ```sh
   curl http://127.0.0.1:3000/healthz
   ```

5. DM the bot from the configured owner account with `remind me at 6pm tomorrow to run`, then use `tasks` to verify local task support. If Google OAuth settings are configured, send `/connect`, complete consent, then send `/status` to verify the selected calendar.

## Configuration

Empty values are treated as unset. The bot starts in health-only mode when no local bot values are set. To enable Discord and local tasks, configure **all three** local values: `DISCORD_BOT_TOKEN`, `DISCORD_OWNER_ID`, and `ENCRYPTION_KEY`. Google Calendar remains optional and requires all three Google settings together. Gemini remains optional and requires both Gemini settings together.

| Variable | Default | Purpose |
|---|---:|---|
| `NODE_ENV` | `development` | One of `development`, `test`, or `production`. |
| `HOST` | `127.0.0.1` | HTTP listener address. Keep loopback-only behind a reverse proxy. |
| `PORT` | `3000` | HTTP listener port. |
| `LOG_LEVEL` | `info` | Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`. |
| `DATABASE_PATH` | `./data/calendar-bot.sqlite` | SQLite path. Use an absolute persistent path in production. |
| `REMINDER_POLL_INTERVAL_SECONDS` | `60` | Reminder poll interval, 15–300 seconds. |
| `LOCAL_TASK_TIME_ZONE` | `America/Toronto` | IANA zone used for local task parsing, storage display, and DST checks. |
| `DISCORD_BOT_TOKEN` | — | Discord bot token; required for the local Discord/task runtime. |
| `DISCORD_OWNER_ID` | — | The sole permitted Discord user ID (17–20 digits). |
| `ENCRYPTION_KEY` | — | Secret of at least 32 characters used to encrypt OAuth credentials, pending actions, and local task titles. |
| `GOOGLE_CLIENT_ID` | — | Optional Google OAuth web-client ID. |
| `GOOGLE_CLIENT_SECRET` | — | Optional Google OAuth web-client secret. |
| `GOOGLE_REDIRECT_URI` | — | Optional exact public callback URL, normally `https://calendar.example.com/oauth/google/callback`. |
| `GEMINI_API_KEY` | — | Optional Gemini API key; requires `GEMINI_MODEL`. |
| `GEMINI_MODEL` | — | Optional Gemini model identifier; requires `GEMINI_API_KEY`. |

A local-task-only installation needs the three local values. Google Calendar features start only when all Google values are present; `/status` reports Google as unconfigured otherwise, and `/connect` / `/disconnect` explain that availability. The local task timezone must be a valid IANA timezone. `America/Toronto` observes DST, so date parsing and display follow Toronto’s current offset.

## Discord setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application, and add a bot user.
2. Copy the bot token into `DISCORD_BOT_TOKEN`. Treat it like a password; never commit it or paste it into logs.
3. Enable Developer Mode in the Discord client, copy your own user ID, and set it as `DISCORD_OWNER_ID`.
4. Install the bot where the owner can DM it and ensure the owner’s Discord privacy settings allow DMs from that context.
5. This implementation requests only the Direct Messages gateway intent and channel partials. It intentionally does not process guild messages or use registered Discord application commands—the `/connect`, `/disconnect`, and `/status` inputs are ordinary DM text. See Discord’s [Gateway documentation](https://discord.com/developers/docs/events/gateway) for intent details.

## Google Cloud and OAuth setup

1. In Google Cloud, create or select a project and enable the Google Calendar API.
2. Configure the OAuth consent screen for the appropriate account type. For a personal/testing deployment, add the owner as an allowed test user when Google requires it. A broadly published app can trigger Google’s sensitive-scope review requirements.
3. Create an **OAuth 2.0 Client ID** of type **Web application**.
4. Register one authorized redirect URI that exactly matches `GOOGLE_REDIRECT_URI`, including scheme, hostname, port, path, and trailing-slash behavior. This application’s callback path is:

   ```text
   /oauth/google/callback
   ```

5. Put the generated client ID and secret into the environment file.

The app asks for these scopes:

```text
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.calendarlist.readonly
```

The OAuth URL requests offline access and explicit consent so a refresh token can be stored encrypted locally. If Google does not return a refresh token, use `/disconnect`, then `/connect` again and approve access.

Use the official [OAuth web-server guide](https://developers.google.com/identity/protocols/oauth2/web-server) and [Calendar authorization-scope reference](https://developers.google.com/workspace/calendar/api/auth) when configuring the Cloud project.

## Optional Gemini fallback

Leave both `GEMINI_API_KEY` and `GEMINI_MODEL` empty to run without hosted AI. When enabled, Gemini is called only after deterministic parsing reports an **unsupported** task-shaped or calendar request. A recognized command missing a title, date, or time is never sent to Gemini; the bot asks for that missing detail instead. Failed, incomplete, malformed, or unsafe model output falls back safely without a write.

### Enable Gemini

1. Create an API key in your Gemini/Google AI account. Keep the key private; never commit, log, or paste it into chat or a support request.
2. In your private environment file, set **both** values together:

   ```ini
   GEMINI_API_KEY=your-private-api-key
   GEMINI_MODEL=your-supported-model-id
   ```

   `GEMINI_API_KEY` is the secret credential used to authenticate requests. `GEMINI_MODEL` is the non-secret, bare identifier of the Gemini model that should handle fallback parsing—it is **not** another API key. Copy a supported model identifier from your Gemini account; this application accepts only letters, numbers, `.`, `_`, and `-`, so do not use a URL or a `models/` prefix.
3. Restart the bot after changing its environment. The application rejects a partial Gemini setup: both values must be set, or both must be blank.

### Verify and troubleshoot Gemini safely

Use a benign, complete, unsupported task-shaped request through the owner DM path to exercise the fallback; do not use personal task content or paste credentials into a command. A model-proposed mutation must be reviewed with `confirm <id>`; cancel the pending action instead of confirming it when testing only. If a generic structured-output smoke test or fallback yields no proposal, verify that both variables are present, the selected model supports Gemini Interactions structured JSON output, and the account has current provider availability and quota. Invalid, malformed, incomplete, or unsafe provider output is intentionally discarded without a write or a raw provider response in logs. See Google's [Interactions structured-output guide](https://ai.google.dev/gemini-api/docs/interactions/structured-output) for compatible request behavior.

The calendar and local-task planners receive only the owner’s unsupported request text, current time, and the relevant IANA time zone. The task planner always uses `LOCAL_TASK_TIME_ZONE`; it does not receive task rows, task IDs, task history, calendar events, OAuth data, Discord metadata, database data, or tool access. Requests are storage-disabled where the Gemini SDK supports it, returned JSON is strictly validated locally, and every model-proposed local-task create/complete/cancel or Calendar mutation requires `confirm <id>`. Read-only task listing may execute directly.

The Gemini key is never printed, logged, or written to repository files. Free-tier availability, quotas, supported models, regions, and pricing are provider-account dependent and can change. Do not assume a particular model remains free. Choose a compatible model identifier from your Google AI account and plan for quota failures to safely fall back to deterministic behavior. See Google’s [API-key guide](https://ai.google.dev/gemini-api/docs/api-key), [rate-limit reference](https://ai.google.dev/gemini-api/docs/rate-limits), and [pricing page](https://ai.google.dev/gemini-api/docs/pricing).

## HTTPS reverse proxy and health endpoints

The Node process listens over HTTP only. In production, set `HOST=127.0.0.1` and place a TLS reverse proxy in front of it. The proxy must pass the exact callback path and query string to the local process:

```text
https://calendar.example.com/oauth/google/callback
  -> http://127.0.0.1:3000/oauth/google/callback
```

Useful GET-only endpoints:

| Endpoint | Meaning |
|---|---|
| `/healthz` | The HTTP process is serving requests. |
| `/readyz` | Currently equivalent to process liveness in this application; it does not prove Discord, Google OAuth, or reminders are connected. |
| `/oauth/google/callback` | Google OAuth callback; available only when the full integration is configured. |

Do not expose the raw HTTP port to the internet. Terminate TLS at the reverse proxy and protect any public health endpoint according to your monitoring design.

## systemd deployment

The repository includes [`deploy/discord-calendar-assistant.service`](deploy/discord-calendar-assistant.service), a baseline single-instance unit. It deliberately uses `node dist/index.js` directly so systemd sends `SIGTERM` to Node rather than an npm wrapper.

### Prepare files and secrets

Use a non-login service account and persistent state directory. Adapt paths and the Node executable for the host:

```sh
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin calendar || true
sudo install -d -o calendar -g calendar -m 0750 /srv/discord-calendar-assistant
sudo install -d -o root -g calendar -m 0750 /etc/discord-calendar-assistant
sudo install -d -o calendar -g calendar -m 0700 /var/lib/discord-calendar-assistant
```

Deploy the application to `/srv/discord-calendar-assistant`, then run the supported build steps there with a Node 22 runtime:

```sh
npm ci
npm run check
npm test
npm run build
```

Create `/etc/discord-calendar-assistant/calendar.env` with mode `0600`, owned by root. Use one `KEY=value` entry per line and replace every placeholder:

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/var/lib/discord-calendar-assistant/calendar-bot.sqlite
LOG_LEVEL=info
REMINDER_POLL_INTERVAL_SECONDS=60
LOCAL_TASK_TIME_ZONE=America/Toronto
DISCORD_BOT_TOKEN=replace-me
DISCORD_OWNER_ID=123456789012345678
ENCRYPTION_KEY=replace-with-a-durable-random-secret
# Optional Google Calendar integration: include all three or none.
# GOOGLE_CLIENT_ID=replace-me.apps.googleusercontent.com
# GOOGLE_CLIENT_SECRET=replace-me
# GOOGLE_REDIRECT_URI=https://calendar.example.com/oauth/google/callback
# Optional Gemini fallback: include both or neither.
# GEMINI_API_KEY=replace-me
# GEMINI_MODEL=replace-with-a-supported-model-id
```

```sh
sudo chown root:root /etc/discord-calendar-assistant/calendar.env
sudo chmod 0600 /etc/discord-calendar-assistant/calendar.env
sudo install -m 0644 deploy/discord-calendar-assistant.service \
  /etc/systemd/system/discord-calendar-assistant.service
sudo systemctl daemon-reload
sudo systemctl enable --now discord-calendar-assistant
sudo systemctl status discord-calendar-assistant
```

If Node is not `/usr/bin/node`, update `ExecStart` in the installed unit. Keep one running instance. Workers sharing a single SQLite database use durable reminder claims to prevent an overlapping send for a live slot, but one instance remains recommended: claims do not coordinate separate databases, and a Discord send cannot be atomic with the durable delivery record.

## Storage, backups, and logs

- SQLite uses WAL mode. The service account needs write access to the database directory for the `.sqlite`, `-wal`, and `-shm` files—not merely the main database file.
- OAuth credentials, pending actions, and local task titles are AES-GCM encrypted using `ENCRYPTION_KEY`; reminder delivery and claim/lease metadata, task lifecycle timestamps, and audit metadata are not full-database encrypted. Protect the host, the database directory, and the environment file accordingly.
- Back up the database **and** the encryption key. For a simple filesystem backup, stop the service first, then copy/archive the database directory so the SQLite sidecar files are consistent:

  ```sh
  sudo systemctl stop discord-calendar-assistant
  sudo tar -C /var/lib -czf calendar-assistant-backup.tgz discord-calendar-assistant
  sudo systemctl start discord-calendar-assistant
  ```

  Store the encryption key separately in a protected secret manager or offline recovery process. A database backup without its original key cannot recover OAuth credentials.
- Pino logs go to stdout; under the included systemd unit they are captured by journald. Follow logs with:

  ```sh
  journalctl -u discord-calendar-assistant -f
  ```

  Manage retention with the host’s journald policy (for example, `SystemMaxUse=` in `journald.conf`) or scheduled `journalctl --vacuum-time=30d`. Do not create a second unrotated application log file.

## Troubleshooting

| Symptom | Check |
|---|---|
| Process starts in health-only mode | Configure all three local bot values—Discord token, owner ID, and encryption key—not a partial set. Inspect `journalctl -u discord-calendar-assistant`. |
| `Invalid configuration` on start | Verify the local task timezone, paired Google/Gemini values, owner ID format, port range, and encryption key length. |
| Local task commands fail | Ensure the DM is from `DISCORD_OWNER_ID`, include a title/date/time, and check that `LOCAL_TASK_TIME_ZONE` is valid. Google does not need to be connected. |
| Task reminder repeats unexpectedly | Reply `done <description>` or `cancel task <description>`; reminders repeat every 15 minutes only until two hours after the original due time. |
| `redirect_uri_mismatch` from Google | Ensure the Console URI and `GOOGLE_REDIRECT_URI` match exactly and the reverse proxy forwards `/oauth/google/callback`. |
| Google link succeeds but no usable connection | Re-run `/connect` and approve consent so Google returns or preserves a refresh token. |
| Bot does not respond | DM it from the configured owner account, verify the bot token and owner ID, and check Discord DM/privacy permissions. Guild messages are intentionally ignored. |
| Gemini is never used | Configure both Gemini variables, use an unsupported task-shaped/calendar request with all required details, and check provider quota/model availability. |
| A model-proposed task is not applied | Read the review prompt and reply `confirm <id>` before it expires. Deterministic canonical task commands do not need this confirmation. |
| Reminders duplicate | Use one service instance with one shared SQLite database. Claims prevent an overlapping live-slot send, but a process crash or lease expiry after Discord accepts a DM and before durable completion can retry that slot; delivery is at-least-once. |
| Reminders do not arrive | Check Discord DM availability, local task lifecycle status, service logs, the configured poll interval, and—only for calendar reminders—Google authorization. |

## Validation before release

Run the full local validation suite after changes and before restarting production:

```sh
npm test
npm run check
npm run build
```

## External references

- [Discord Gateway documentation](https://discord.com/developers/docs/events/gateway)
- [Google OAuth 2.0 for web-server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Calendar API authorization scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Gemini API key guidance](https://ai.google.dev/gemini-api/docs/api-key)
- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)

External setup guidance above is summarized from these official sources. Content was rephrased for compliance with licensing restrictions.
