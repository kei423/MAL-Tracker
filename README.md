# MAL Tracker

## Full reset for local testing

Run these commands from `MAL-Tracker` for a completely fresh local test.
**This permanently deletes this project's PostgreSQL and RabbitMQ volumes**:
all local users, MAL credentials, anime, progress, list snapshots, sync jobs,
transaction history, and queued messages. Source code and `.env` remain in
place. Your online MAL list is unchanged.

First stop the API, publisher, and sync worker with **Ctrl+C** in each of
their terminals. Stop `mal:connect` too if its login helper is still running,
and close AniKoto tabs so playback cannot submit new updates during reset.

If testing the browser extension, also clear its saved account, show mappings,
pending requests, and duplicate-detection cache. Open `chrome://extensions`
(or `edge://extensions`), find this extension, click its **service worker**
inspection link, and run these in that DevTools console (not PowerShell):

```javascript
await chrome.storage.local.clear();
await chrome.alarms.clearAll();
```

Then reload the extension. This clears only this extension's local state.

Back in PowerShell, delete and recreate the project's Docker services and
data volumes:

```powershell
docker compose down --volumes
docker compose up -d --wait db rabbitmq
```

PostgreSQL recreates the tables automatically from `db/init.sql`. Connect
your MAL account again and finish browser authorization:

```powershell
npm run mal:connect
```

Login imports your existing online MAL list into the fresh database. Note the
new local `userId`; use it in API tests. In the extension, approve account
changes again and let automatic anime detection identify the playing show.

Start each process in a separate terminal and leave it running.

Terminal 1 — Tracker API:

```powershell
npm run dev
```

Terminal 2 — outgoing job publisher:

```powershell
npm run queue:publish
```

Terminal 3 — MAL sync worker (outgoing updates and incoming list imports):

```powershell
npm run sync:worker
```

In another terminal, verify service health and inspect the fresh state:

```powershell
docker compose ps
Invoke-RestMethod http://localhost:3000/api/db/health
docker compose exec rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
docker compose exec db psql -U tracker -d tracker -c "SELECT id, state, attempts, published_at, synced_at, last_error FROM sync_jobs ORDER BY id DESC LIMIT 20;"
```

Both Docker services should be healthy and the API should return
`database: ok`. Old jobs and queued messages are gone. After login, `progress`
contains the list freshly imported from MAL; new test updates create new jobs
and successful-change history.

For automated regression testing against temporary schemas and queues:

```powershell
npm run test:queue
npm run test:sync
npm run test:extension
```

These tests clean up their own data and use simulated MAL responses rather
than changing your real MAL list. For extension testing, reload the extension
in `chrome://extensions` or `edge://extensions` and refresh AniKoto tabs if
the extension code changed.

## Database setup

Requires Node.js 20 or newer and Docker Desktop. In `MAL-Tracker/.env`, set
`DB_PASSWORD` to a password of your choice. The same value is used by
PostgreSQL in Compose and by the API. Set `DB_PORT=5433` in `.env` to match
the Compose host port (and avoid a conflict with Windows PostgreSQL on 5432).
Optional settings are `DB_HOST` (default `127.0.0.1`), `DB_NAME` (default
`tracker`), and `DB_USER` (default `tracker`). See `.env.example` for all settings.

Run these commands from `MAL-Tracker`:

```powershell
docker compose up -d db
npm install
npm run dev
```

The SQL in `db/init.sql` runs when the Postgres volume is created. If the
volume already existed before adding the schema, apply it once with:

```powershell
Get-Content db/init.sql -Raw | docker compose exec -T db psql -U tracker -d tracker -v ON_ERROR_STOP=1
```

Check the database connection:

```powershell
Invoke-RestMethod http://localhost:3000/api/db/health
```

The API currently accepts a numeric MAL user ID explicitly. Create a local
user row, then save an episode:

```powershell
$user = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/users -ContentType application/json -Body '{"malUserId":22773044}'
$body = @{ userId = [long]$user.userId; malAnimeId = 5114; title = 'Fullmetal Alchemist: Brotherhood'; episode = 1; watchStatus = 'watching' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/progress -ContentType application/json -Body $body
```

Replace the example MAL ID with your MAL account's numeric ID. A successful progress
request stores the anime, current progress, and a pending sync job in one
database transaction. Repeating the same episode does not create another
job.

## RabbitMQ setup

In `.env`, set `RABBITMQ_USER=tracker` and `RABBITMQ_PASSWORD` to a local
password. Compose and the publisher read the same credentials. The current
local `.env` is already configured. The broker listens on `127.0.0.1:5672`;
the management dashboard is at <http://localhost:15672>. Sign in using
`RABBITMQ_USER` and `RABBITMQ_PASSWORD` from `.env`.

RabbitMQ stores users in its data volume. Changing `RABBITMQ_PASSWORD` in
`.env` after the first startup does not update the stored password, even if
you recreate the container. If login fails with `403 ACCESS_REFUSED`, update
the existing user's password using [rabbitmqctl change_password](https://www.rabbitmq.com/docs/man/rabbitmqctl.8#change_password):

```powershell
docker compose exec rabbitmq rabbitmqctl change_password tracker 'your-current-RABBITMQ_PASSWORD'
```

Replace the quoted placeholder with the exact password from `.env` (and
`tracker` if you use another username), then restart the publisher to reload
`.env`. This preserves queued messages and PostgreSQL data.

Start both services:

```powershell
docker compose up -d --wait db rabbitmq
```

For a database created before RabbitMQ was added, apply this migration once
(it preserves existing data and is safe to run again):

```powershell
Get-Content db/migrations/001-rabbitmq.sql -Raw | docker compose exec -T db psql -U tracker -d tracker -v ON_ERROR_STOP=1
```

Keep the API running with `npm run dev`. In a separate terminal, start the
publisher and leave it running:

```powershell
npm run queue:publish
```

The publisher checks `sync_jobs` on startup and every 10 seconds while idle,
and sends ready, unpublished pending jobs to the durable `mal.sync` queue.
It drains available jobs immediately rather than waiting between jobs. Keep
`npm run sync:worker` running in a separate terminal to send queued updates
to MAL as they arrive. Existing pending jobs are picked up too.
It records `published_at` only after RabbitMQ confirms delivery. If RabbitMQ
is unavailable, jobs remain in PostgreSQL and the publisher retries every
five seconds. Broker data is stored in a Docker volume. These settings follow
RabbitMQ's [message durability and publisher confirmation guidance](https://www.rabbitmq.com/tutorials/tutorial-two-javascript).

Save a new episode using the progress request above, then inspect the queue
in the dashboard under **Queues and Streams**, or run:

```powershell
docker compose exec rabbitmq rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers
docker compose exec db psql -U tracker -d tracker -c "SELECT id, state, published_at FROM sync_jobs ORDER BY id;"
```

Messages contain `schemaVersion`, `syncJobId`, `userId`, `malAnimeId`,
`episode`, `watchStatus`, and `progressVersion`. Database BIGINT IDs are
encoded as strings. Delivery is at least once: if the publisher crashes after
RabbitMQ confirms but before PostgreSQL commits, the same job can be sent
again. The MAL Sync consumer deduplicates by `syncJobId`, handles stale
progress versions, and acknowledges after committing the result or a retry.

Jobs stay `pending` after publication; `synced` is reserved for a successful
MAL update. Run the MAL Sync worker described below to consume the queue.
In the dashboard, choose **Ack mode: Nack message requeue true** when using
**Get messages** to inspect messages without removing them.

To verify delivery, duplicate suppression, failure retry, unroutable messages,
and concurrent publishers against the running services:

```powershell
npm run test:queue
```

Tests use a temporary PostgreSQL schema and a separate RabbitMQ queue and
remove their own test data afterward. For compiled execution, run
`npm run build`, then `npm run queue:start` in place of `queue:publish`.

## MAL Sync setup

The local setup now includes a consumer that updates your MAL anime list.
The API listens only on `127.0.0.1`; this is a local development service that
selects accounts by `userId`, not a public service with login sessions.

For an existing database, apply the migration once (already applied to the
current local database during setup):

```powershell
Get-Content db/migrations/002-mal-sync.sql -Raw | docker compose exec -T db psql -U tracker -d tracker -v ON_ERROR_STOP=1
```

Set `MAL_CLIENT_ID` and `MAL_CLIENT_SECRET` in `.env` using your MAL API app.
Set `MAL_REDIRECT_URI` to exactly the app's registered redirect URI, including
any trailing slash; the local default is `http://localhost:8080/`. Refer to
MAL's [authorization settings](https://myanimelist.net/apiconfig/references/authorization).
The callback URL must use `http://localhost` or `http://127.0.0.1`.

If MAL repeatedly displays a browser username/password prompt, verify the
redirect URI first. In this app's configuration, omitting the trailing slash
causes MAL to return `401` with an HTTP Basic authentication prompt. Use
`MAL_REDIRECT_URI=http://localhost:8080/`, then restart `mal:connect` and open
the newly printed local URL. The browser's HTTP authentication prompt is not
the normal MAL account login form.

`MAL_TOKEN_KEY` encrypts the OAuth tokens stored in PostgreSQL. A random key
has already been generated in the current local `.env`. For a fresh setup,
generate a key once and copy it into `.env` as `MAL_TOKEN_KEY`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep this key with your local configuration; changing it makes existing
encrypted tokens unreadable and requires reconnecting accounts.

Restart the API and publisher with `npm run dev` and `npm run queue:publish`
in their respective terminals to reload the updated code and `.env`. Then connect your
MAL account once:

```powershell
npm run mal:connect
```

Open the local URL printed in the terminal (normally
<http://localhost:8080>) and authorize the app on MAL. Stop any other frontend
server on port 8080 first. The temporary callback server exits after success
or ten minutes. It verifies OAuth state and PKCE, reads the authorized
account's numeric MAL ID, and saves encrypted tokens. It prints your local
`userId`; use that value for progress requests. An existing user with the
same MAL ID is reused. The API's existing OAuth callback also persists tokens
and returns `{ success, userId, malUserId }` rather than exposing tokens.
The response also includes `listSync` with the initial list import result.

Keep these running in three separate terminals:

```powershell
npm run dev
```

```powershell
npm run queue:publish
```

```powershell
npm run sync:worker
```

Starting the worker processes existing queued jobs as well as new updates,
and changes your actual MAL list for accounts you have connected. The worker
sends the episode and watch status using MAL's
[Update My List Status endpoint](https://myanimelist.net/apiconfig/references/api/v2#operation/anime_anime_id_my_list_status_put).
It refreshes expired access tokens automatically and stores rotated refresh
tokens. Older local progress is marked `superseded` without sending an
outdated update. It serializes updates per user/anime and skips completed jobs
on duplicate delivery. A crash after MAL accepts an update but before the
database commits may repeat that same update; only episode and status are
sent, so unrelated fields such as score and notes are preserved.

Network errors, HTTP 429, and server errors use scheduled retries (up to five
attempts), honoring `Retry-After` up to one hour. Keep the publisher running
to deliver scheduled retries. Missing or revoked authorization leaves a job
pending with a `last_error` explaining that you must run `mal:connect` again;
these authorization waits do not exhaust attempts and are checked every
minute. Permanent errors and exhausted retries become `failed`. Messages
with an invalid format are moved to `mal.sync.dead` for inspection.

Inspect job status (replace `1` with the local user ID printed during login):

```powershell
Invoke-RestMethod 'http://localhost:3000/api/sync/jobs?userId=1' | Select-Object -ExpandProperty jobs | Format-Table id, episode, state, attempts, last_error
docker compose exec db psql -U tracker -d tracker -c "SELECT id, state, attempts, synced_at, last_error FROM sync_jobs ORDER BY id;"
```

After fixing a permanent error, retry a specific job by replacing `123` with
its job ID:

```powershell
docker compose exec db psql -U tracker -d tracker -c "UPDATE sync_jobs SET state = 'pending', attempts = 0, last_error = NULL, published_at = NULL, next_attempt_at = now() WHERE id = 123 AND state = 'failed';"
```

The anime-list endpoint now requires the connected local account ID:

```powershell
Invoke-RestMethod 'http://localhost:3000/api/mal/animelist?userId=1'
```

Run the integration tests with PostgreSQL and RabbitMQ running:

```powershell
npm run test:sync
```

Tests use a temporary schema and queue with simulated MAL responses; they
never update a real MAL account. They cover OAuth persistence, encryption,
delivery, duplicates, old progress, token refresh, retries, failed jobs, and
malformed messages. For compiled execution use `npm run build` followed by
`npm run sync:start` instead of `sync:worker`.

## Successful change history

The `transactions` table stores one row per successful MAL progress update:
the sync job ID, local user ID, MAL anime ID, episode, watch status, progress
version, and success timestamp (`synced_at`). Pending, failed, and superseded
jobs do not create history entries. Each row is a snapshot of the values
successfully sent to MAL, so later progress updates do not overwrite it.

For an existing database, apply this migration (already applied to the current
local database during setup):

```powershell
Get-Content db/migrations/003-transaction-history.sql -Raw | docker compose exec -T db psql -U tracker -d tracker -v ON_ERROR_STOP=1
```

The migration backfills previously synced jobs using their original success
timestamps and is safe to run again. A PostgreSQL trigger records future
successes in the same database transaction that marks a job `synced`; no
worker restart is needed. A unique `sync_job_id` prevents duplicate history
entries on RabbitMQ redelivery. If recording history fails, the job's success
update rolls back and the worker cannot acknowledge the message.

Read recent successful changes:

```powershell
docker compose exec db psql -U tracker -d tracker -c "SELECT * FROM transactions ORDER BY synced_at DESC, id DESC LIMIT 50;"
```

To include MAL user IDs and anime titles:

```sql
SELECT t.id, u.mal_user_id, a.title, t.episode, t.watch_status, t.synced_at
FROM transactions t
JOIN users u ON u.id = t.user_id
JOIN anime a ON a.mal_anime_id = t.mal_anime_id
ORDER BY t.synced_at DESC, t.id DESC;
```

If resetting all local data, include `transactions` in the same `TRUNCATE`
statement as `mal_list_entries`, `sync_jobs`, `progress`, `anime`, `mal_accounts`, and `users`,
because the history references those users, anime, and jobs.

## Importing the user's MAL list

After a successful login, the backend downloads every page of that user's
anime list and saves it locally. Both `mal:connect` and the browser callback
use this import. A failed download does not discard a successful login or
new OAuth credentials: the response reports a pending import and the worker
retries it, leaving the last complete snapshot in place.

For an existing database, apply this migration once (already applied to the
current local database):

```powershell
Get-Content db/migrations/004-mal-list-import.sql -Raw | docker compose exec -T db psql -U tracker -d tracker -v ON_ERROR_STOP=1
```

Restart `npm run dev` and `npm run sync:worker` after updating the code. The
existing sync worker now handles both outgoing RabbitMQ jobs and incoming
list imports, so there is no additional service to start. It checks for due
imports every 10 seconds:

- Login imports the list immediately.
- An access-token refresh requests another import, picked up on the next
  scheduler pass. Token expiration still comes from MAL's `expires_in`.
- The worker also refreshes each connected account's list every 10 seconds,
  even if its token has not expired. Change this interval with
  `MAL_LIST_SYNC_INTERVAL_SECONDS` in `.env` (10–86400 seconds). This replaces
  the old `MAL_LIST_SYNC_INTERVAL_MINUTES` setting. Restarting the worker
  shortens existing successful-import schedules to the new interval too.
- Failed imports retry after at least one minute, honoring `Retry-After`
  up to one hour. Revoked authorization requires `npm run mal:connect` again.

Manual changes made on the MAL website (episode counts, watch status,
additions, and removals) reach both `mal_list_entries` and `progress` through
this background import loop. No local API request, new outgoing job, or token
refresh is required. Keep `npm run sync:worker` running; its startup message
prints the configured import interval. Changes appear on the next scheduled
import, approximately every 10 seconds by default, plus request/processing
time. Outgoing updates are also checked every 10 seconds.

`mal_list_entries` stores the last complete remote snapshot: user/anime IDs,
episode, watch status, the full MAL `list_status` JSON (including fields such
as score), and `fetched_at`. The `anime` table receives MAL titles. The
`progress` table is the local copy used for tracking. MAL is authoritative
whenever a full list import succeeds:

- MAL values overwrite local progress, including lower episode counts,
  changed statuses, and pending or failed local edits.
- Edits made locally during a download are also overwritten when the import
  commits. Local-only entries absent from MAL are removed, even if they have
  unsent changes. An empty MAL list clears the user's entire local list.
- All pending and failed sync jobs for that user become `superseded` in the
  same transaction. RabbitMQ messages already queued for those jobs are
  acknowledged without sending their old values to MAL.
- New local updates created after the import commits can sync normally.
  Other users' lists and sync jobs are unaffected.

All pages must download and validate before a snapshot is replaced. Imports
do not create outbound sync jobs or `transactions` history entries, preventing
an import from sending the same list straight back to MAL. Existing sync jobs
and successful-change history remain available after remote removals. If a
download or database update fails, list replacement and job supersession do
not take effect; the previous local data and queued changes remain intact.

Read the saved MAL snapshot without making a request to MAL (replace `2`
with your local user ID):

```powershell
Invoke-RestMethod 'http://localhost:3000/api/mal/animelist/local?userId=2'
docker compose exec db psql -U tracker -d tracker -c "SELECT user_id, mal_anime_id, episode, watch_status, fetched_at FROM mal_list_entries ORDER BY user_id, mal_anime_id;"
```

Request an immediate import:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/mal/animelist/sync -ContentType application/json -Body '{"userId":"2"}'
```

`GET /api/mal/animelist?userId=2` also fetches and imports a fresh list before
returning it. The `/local` response includes `list_synced_at`,
`list_sync_next_attempt_at`, `list_sync_error`, and `reauth_required`. These
fields can also be inspected directly in `mal_accounts`; tokens are never
returned by the list endpoints.

`npm run test:sync` covers list imports alongside outgoing sync and token
refresh, using simulated MAL responses and isolated PostgreSQL schemas.

## Browser extension and Tracker API

The Manifest V3 extension now sends watched episodes to the local Tracker
API. The complete path is playback capture → extension background worker →
Tracker PostgreSQL job → RabbitMQ → MAL Sync worker → MAL. OAuth tokens and
the MAL client secret stay on the backend; the extension stores only the
selected account IDs, show mappings, pending API requests, and sync status.

Start the database and broker, then keep the API, publisher, and worker
running in separate terminals:

```powershell
docker compose up -d --wait db rabbitmq
```

```powershell
npm run dev
```

```powershell
npm run queue:publish
```

```powershell
npm run sync:worker
```

Connect your MAL account with `npm run mal:connect` and finish browser
authorization if you have not already done so. In Chrome/Edge:

1. Open `chrome://extensions` (or `edge://extensions`), enable Developer
   mode, and **Load unpacked**, choosing the `MAL-Tracker` folder. If already
   installed, click **Reload** to pick up the new background worker and
   localhost host permissions. Refresh existing AniKoto tabs afterward.
2. Open a watch page on `anikototv.bz`, then open the extension popup.
3. The extension automatically selects the only connected account, or keeps
   your previously selected valid account. If multiple accounts are connected
   and no saved choice is valid, choose the intended account explicitly.
4. A prompt asks **Allow changes to your MAL account?** Click **Allow updates**
   to permit watched-episode and watching/completed status updates and enable automatic
   saving. **Not now** leaves updates disabled. The decision is remembered for
   that account; selecting an account alone never grants write permission.
5. Anime detection runs automatically after approval, without a manual
   search or anime selection. It uses a MAL link/ID in the page's main anime
   information when available, otherwise a unique exact title/alias match
   from MAL (including English/Japanese titles and synonyms). The popup shows
   **Automatically detected** with the MAL title and ID. Results are cached
   across episodes for that account and detected show title.
6. At 90% playback, the extension sends the integer episode number to
   `POST /api/extension/progress`. It sends `watchStatus: completed` when the
   episode equals MAL's known total episode count; otherwise it sends
   `watchStatus: watching`. A MAL episode count of `0` means unknown, so the
   anime stays watching. Repeated video events do not create repeated API
   requests for the same episode and status. A final episode previously sent
   as watching can still receive a completed update.

If no exact match exists or multiple seasons share the same alias, the
extension asks for a correction instead of choosing the first search result.
Use **Correct an unmatched or incorrect show** to search or enter a MAL
ID/URL, then **Confirm MAL correction**. Explicit corrections override later
automatic matches. Season numbers remain part of title matching; only
punctuation, case, spacing, and trailing `(Dub)`/`(Sub)` annotations are
normalized. A page MAL ID that appears later can correct an earlier automatic
match. Ambiguous/unmatched searches are cached for five minutes to avoid
repeated MAL requests; **Retry anime detection** retries immediately. Failed
lookups retry through the extension's alarm once the API is available.

Use **Allow account changes** to approve later after declining, or **Revoke
account permission** to disable new submissions and clear unsent extension
requests. Revocation works even if the API is offline. Requests already
accepted by the Tracker API may still finish in the backend. The automatic
saving checkbox can also pause/resume delivery without revoking permission.
The background worker checks the account-specific decision before creating
requests and before sending retries, including after an extension/browser
restart. Existing enabled settings from before this permission feature need
explicit approval too; the extension does not silently grant consent.

The API validates the selected local/MAL account pair, preventing a saved
extension configuration from updating a different account after a database
reset. Reselect your connected account in the popup after resetting the
database. Revoked authorization also requires reconnecting MAL.

The extension's API endpoint stores progress using the same transaction as
`POST /api/progress`, then tries to publish that specific job immediately.
If RabbitMQ is unavailable, the saved job remains pending for the 10-second
publisher. Immediate publication helps avoid the next authoritative MAL
import superseding a watched episode before it can be delivered.

The popup distinguishes pending delivery, a MAL-confirmed sync, failed jobs,
and jobs superseded by a MAL import. Since MAL remains authoritative, an
import may cancel an unsent update; the extension shows `superseded` rather
than claiming it was sent or repeatedly trying to undo the import.

API requests run in the background worker with localhost host permissions,
following Chrome's [cross-origin request guidance](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).
The existing cross-origin player-frame capture is retained, with duplicate
injection protection, inline-video support, and child-frame message checks.
Only supported AniKoto top-level pages can report progress to the worker.

If the Tracker API is offline, the extension retains the episode request in
browser storage and retries using a 30-second Chrome alarm, or when clicking
**Retry API / refresh sync status**. That is separate from the backend's
10-second publish/import schedules. Closing the popup does not stop tracking.
Changing the selected account discards unsent extension requests for the old
account; it does not remove already-created Tracker jobs. Disabling automatic
saving pauses delivery of extension requests.

Run extension integration checks with PostgreSQL and RabbitMQ running:

```powershell
npm run test:extension
```

These tests exercise the actual content/background scripts with simulated
browser APIs, a real Tracker HTTP server, PostgreSQL, RabbitMQ, and simulated
MAL responses. They do not change a real MAL list. They cover the 90% playback
threshold, final-episode completion, unknown episode counts, account selection,
confirmed anime mapping, duplicates, outages, and
superseded jobs. Live-player DOM changes still require checking the browser
capture on the supported streaming site.

With the Tracker API running, an optional real-Chrome load/popup check is:

```powershell
npm run test:extension:browser
```

It launches headless Chrome with a temporary isolated profile, loads the
extension through Chrome's DevTools automation interface, and verifies popup
account loading from the Tracker API. With one valid account it also checks
auto-selection, the permission prompt, and **Not now**. It never enables automatic saving or
submits playback. On Windows it uses the standard Chrome installation;
set `CHROME_PATH` to your Chrome executable if needed. The test profile is
removed afterward.

If the API is stopped, run `npm run build` followed by
`node tests/extension.browser-smoke.mjs --start-api` to use a temporary API
process that is stopped after the browser check.
