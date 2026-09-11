# Fortis EasyChat hourly sync

This service bridges FitBase/EasyChat to the existing Fortis Google Sheet without re-downloading the full chat history every hour.

## How it works

1. Uses an authenticated FitBase browser session cookie to call `/easychat/get-chat-url`.
2. Opens the returned EasyChat page in headless Chromium and captures the current EasyChat HTTP `Authorization` header and WebSocket URL.
3. Fetches the EasyChat dialogue list and keeps only dialogues whose `last_message_at` changed after the sync cursor.
4. Opens one WebSocket and downloads only recent message pages for those dialogues.
5. Returns normalized JSON from `/sync`.
6. Google Apps Script calls `/sync` hourly and appends only new messages to `Чаты_API` or `Чаты_непривязанные`.

## Security model

- Never paste FitBase cookies, EasyChat Authorization values, WebSocket chat tokens, or `SYNC_KEY` into ChatGPT.
- Put secrets directly into Render Environment variables and Google Apps Script Script Properties.
- Prefer a dedicated FitBase staff account with the minimum rights needed to access FitBase Chat.
- `/sync` and `/auth-check` require the `X-Sync-Key` header.
- The service never returns captured EasyChat credentials to clients.

## Render setup

Deploy this repository as a Render Blueprint or Docker Web Service.

The included `render.yaml` starts on Render's **free** web-service plan for validation. If Chromium is too slow or memory-constrained in real use, upgrade the service after testing; do not switch plans until you have verified the sync works.

Required environment variables:

- `FITBASE_DOMAIN=j50552`
- `FITBASE_CHAT_ID=254411210`
- `FITBASE_CHANNEL_ID=5885`
- `FITBASE_COOKIE=<full Cookie request header from an authenticated FitBase request>`
- `SYNC_KEY=<long random secret>`

`FITBASE_COOKIE` must be entered directly in Render, not sent in chat.

### Getting FITBASE_COOKIE safely

While logged into `https://j50552.fitbase.io` in Chrome:

1. Open DevTools → Network.
2. Click a normal request to `j50552.fitbase.io`.
3. Under Request Headers, copy the complete `Cookie` header value.
4. Paste it directly into the Render environment variable `FITBASE_COOKIE`.

If `/auth-check` later reports that the FitBase session is not accepted, repeat these steps and replace only that Render environment variable. Because the service calls FitBase every hour, active sessions may remain usable for a long time, but session lifetime is controlled by FitBase and cannot be guaranteed.

## Google Apps Script setup

Copy `apps-script/FortisChatSync.gs` into the existing container-bound Apps Script project for the `Fortis API` spreadsheet.

In Apps Script → Project Settings → Script Properties, add:

- `CHAT_SYNC_URL` = public Render URL, without a trailing slash
- `CHAT_SYNC_KEY` = same value as Render `SYNC_KEY`

Then run, in this order:

1. `testFortisChatService` — expected HTTP 200 with `{"ok":true,...}`.
2. `syncFortisChats` — verifies new messages can be appended.
3. `setupFortisChatHourlyTrigger` — creates the hourly trigger.

The Apps Script advances its sync cursor only after a fully successful run. If a dialogue fails even after retry, already-appended rows remain deduplicated and the next hourly run retries from the previous cursor instead of skipping messages.

Do not store secrets in sheet cells.

## Endpoints

- `GET /health` — public health check, no secrets.
- `GET /auth-check` — protected; verifies FitBase → EasyChat credential refresh works.
- `GET /sync?since=<unix-seconds>&overlap_seconds=120` — protected incremental sync.

## Important limitation

The external service starts from the current authenticated FitBase session cookie. FitBase controls that session's lifetime. If FitBase invalidates it, automatic chat sync pauses until `FITBASE_COOKIE` is refreshed in Render. The service deliberately does not store a FitBase password.
