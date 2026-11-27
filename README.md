# MAL Tracker

## Database setup

Requires Node.js 20 or newer and Docker Desktop. In `MAL-Tracker/.env`, set
`DB_PASSWORD` to a password of your choice. The same value is used by
PostgreSQL in Compose and by the API. Optional settings are `DB_HOST`
(default `127.0.0.1`), `DB_PORT` (default `5432`), `DB_NAME` (default
`tracker`), and `DB_USER` (default `tracker`).

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
$user = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/users -ContentType application/json -Body '{"malUserId":12345}'
$body = @{ userId = [long]$user.userId; malAnimeId = 5114; title = 'Fullmetal Alchemist: Brotherhood'; episode = 1; watchStatus = 'watching' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/progress -ContentType application/json -Body $body
```

Replace `12345` with your MAL account's numeric ID. A successful progress
request stores the anime, current progress, and a pending sync job in one
database transaction. Repeating the same episode does not create another
job. RabbitMQ delivery and MAL updates are later steps.
