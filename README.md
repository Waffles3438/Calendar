# Discord Calendar Assistant

A single-owner Discord DM bot for Google Calendar. It reads the configured owner’s calendar, sends reminder DMs, and supports safe natural-language calendar changes. Common commands use a deterministic parser; an optional Gemini fallback handles unsupported wording without receiving calendar events, OAuth credentials, Discord data, or execution access.

## Operating model

- **One person, direct messages only.** The bot ignores guild messages, bot messages, and DMs from everyone except `DISCORD_OWNER_ID`.
- **No setup wizard or public onboarding.** The configured owner starts Google authorization by sending `/connect` in a DM.
- **Safe writes.** Ambiguous targets, deletes, attendee changes, recurring-series changes, guest-impacting changes, and every Gemini-proposed mutation require a one-time `confirm <id>` reply. `cancel <id>` stops a pending action.
- **Least-privilege Google access.** The app requests `calendar.events` plus read-only calendar-list access; it does not use a service account.
- **Optional hosted AI.** Gemini is disabled unless both Gemini variables are configured. The deterministic parser and reminders work without it.

## Requirements

- Node.js **22.15.0 through 22.x** and npm 11.11.0 (see `package.json`).
- A Discord application with a bot token and the owner’s Discord user ID.
- A Google Cloud OAuth client for a web application, with a public HTTPS callback URL.
- For production: one Linux host with systemd, persistent writable storage for SQLite, and a TLS reverse proxy. The service itself is plain HTTP only.

## Quick start

1. Install dependencies and validate the checkout:

   ```sh
   npm ci
   npm run check
   npm test
   npm run build
   ```

2. Copy `.env.example` to `.env`, populate the required values below, and generate a durable encryption secret. For example:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

   Keep that value private and unchanged after the first Google connection. Changing it makes existing encrypted OAuth credentials and pending actions unreadable.

3. For a local run, load the file explicitly—this application does **not** load `.env` itself:

   ```sh
   node --env-file=.env dist/index.js
   ```

   `npm start` runs `node dist/index.js` and expects the environment to already be set. For a systemd deployment, use the included `EnvironmentFile` configuration instead.

4. Confirm the listener is running:

   ```sh
   curl http://127.0.0.1:3000/healthz
   ```

5. DM the bot from the configured owner account with `/connect`, open the returned Google authorization link, complete consent, then send `/status` to verify the selected calendar.

## Configuration

Empty values are treated as unset. The bot starts in health-only mode when none of the six core integration variables are set; if any one is set, **all six** are required.

| Variable | Default | Purpose |
|---|---:|---|
| `NODE_ENV` | `development` | One of `development`, `test`, or `production`. |
| `HOST` | `127.0.0.1` | HTTP listener address. Keep loopback-only behind a reverse proxy. |
| `PORT` | `3000` | HTTP listener port. |
| `LOG_LEVEL` | `info` | Pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`. |
| `DATABASE_PATH` | `./data/calendar-bot.sqlite` | SQLite path. Use an absolute persistent path in production. |
| `REMINDER_POLL_INTERVAL_SECONDS` | `60` | Reminder poll interval, 15–300 seconds. |
| `DISCORD_BOT_TOKEN` | — | Discord bot token; required for the full integration. |
| `DISCORD_OWNER_ID` | — | The sole permitted Discord user ID (17–20 digits). |
| `GOOGLE_CLIENT_ID` | — | Google OAuth web-client ID. |
| `GOOGLE_CLIENT_SECRET` | — | Google OAuth web-client secret. |
| `GOOGLE_REDIRECT_URI` | — | Exact public callback URL, normally `https://calendar.example.com/oauth/google/callback`. |
| `ENCRYPTION_KEY` | — | Secret of at least 32 characters used to encrypt OAuth credentials and pending actions. |
| `GEMINI_API_KEY` | — | Optional Gemini API key; requires `GEMINI_MODEL`. |
| `GEMINI_MODEL` | — | Optional Gemini model identifier; requires `GEMINI_API_KEY`. |

The required core set is `DISCORD_BOT_TOKEN`, `DISCORD_OWNER_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `ENCRYPTION_KEY`. The Google values must be configured together; the Gemini values must be configured together.

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

Leave both `GEMINI_API_KEY` and `GEMINI_MODEL` empty to run without hosted AI. When enabled, Gemini is called only after the deterministic parser reports an unsupported intent; incomplete or failed model output falls back to the deterministic clarification without a calendar write.

The planner receives only the owner’s unsupported request text, current time, and IANA time zone. It has no tools and no Calendar, OAuth, Discord, event-list, or database capability. Returned JSON is validated locally, and every model-proposed create, update, deletion, attendee edit, or reminder requires confirmation.

Free-tier availability, quotas, supported models, regions, and pricing are provider-account dependent and can change. Do not assume a particular model remains free. Choose a compatible model identifier from your Google AI account, test it with the bot, and plan for quota failures to safely fall back to deterministic behavior. See Google’s [API-key guide](https://ai.google.dev/gemini-api/docs/api-key), [rate-limit reference](https://ai.google.dev/gemini-api/docs/rate-limits), and [pricing page](https://ai.google.dev/gemini-api/docs/pricing).

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
DISCORD_BOT_TOKEN=replace-me
DISCORD_OWNER_ID=123456789012345678
GOOGLE_CLIENT_ID=replace-me.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=replace-me
GOOGLE_REDIRECT_URI=https://calendar.example.com/oauth/google/callback
ENCRYPTION_KEY=replace-with-a-durable-random-secret
# Optional: include both or neither.
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

If Node is not `/usr/bin/node`, update `ExecStart` in the installed unit. Keep exactly one running instance: reminder delivery deduplication is persisted but is not a cross-process claim, so multiple replicas can send duplicate reminders.

## Storage, backups, and logs

- SQLite uses WAL mode. The service account needs write access to the database directory for the `.sqlite`, `-wal`, and `-shm` files—not merely the main database file.
- OAuth credentials and pending actions are AES-GCM encrypted using `ENCRYPTION_KEY`; reminder and audit metadata are not full-database encrypted. Protect the host, the database directory, and the environment file accordingly.
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
| Process starts in health-only mode | Configure all six core integration variables, not a partial set. Inspect `journalctl -u discord-calendar-assistant`. |
| `Invalid configuration` on start | Verify paired Google and Gemini values, the owner ID format, port range, and the encryption key length. |
| `redirect_uri_mismatch` from Google | Ensure the Console URI and `GOOGLE_REDIRECT_URI` match exactly and the reverse proxy forwards `/oauth/google/callback`. |
| Google link succeeds but no usable connection | Re-run `/connect` and approve consent so Google returns or preserves a refresh token. |
| Bot does not respond | DM it from the configured owner account, verify the bot token and owner ID, and check Discord DM/privacy permissions. Guild messages are intentionally ignored. |
| Gemini is never used | Configure both Gemini variables, make sure the wording is unsupported by the deterministic parser, and check provider quota/model availability. |
| A calendar mutation is not applied | Read the confirmation prompt, reply `confirm <id>` before it expires, and repeat the request if Google reports an ETag or series change. |
| Reminders duplicate | Run one service instance only; a restart during delivery can also retry an unrecorded send. |
| Reminders do not arrive | Check Discord DM availability, Google authorization, the service logs, calendar event status, and the configured poll interval. |

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
