# WP Control Hub

Next.js dashboard on Cloudflare Workers (OpenNext + D1 + Cron) that manages many WordPress sites through the
`wp-plugin/wp-control-hub` connector plugin.

| Feature | How |
|---|---|
| Malware scan every 2 days | Plugin checks core files against wordpress.org checksums, PHP in uploads, unknown files in core dirs, and known malicious code patterns |
| Daily admin account check | Plugin lists administrators; hub flags more than `MAX_ADMINS` or anyone not in the site's allowed list |
| Daily backup to Google Drive | Plugin zips files + DB dump and uploads it to a Drive folder via a one-off upload URL from the hub (sites never hold Google credentials) |
| Daily updates with rollback | After the backup, plugin updates core/plugins/themes, loads the home page and login page, and restores the backup automatically if either fails |
| Manual rollback / remote restore | Site page → Backups → Restore (backups taken before updates are marked "pre-update") |

Flow: hub sends a signed command → plugin queues it in WP-Cron and replies 202 → when done, plugin POSTs a signed report to `/api/report`.
Both directions use HMAC-SHA256 with a per-site secret and a 5-minute timestamp window.

## Setup

1. `npm install`
2. `npx wrangler d1 create wp-control-hub` and put the `database_id` in `wrangler.jsonc`
3. `npm run db:init`
4. Google Drive: in Google Cloud Console enable the Drive API, create an OAuth client (type *Web application*, redirect URI `https://developers.google.com/oauthplayground`). Set the consent screen to *Internal* (Workspace) or *In production* — in *Testing* the refresh token expires after 7 days. In the [OAuth Playground](https://developers.google.com/oauthplayground) tick “Use your own OAuth credentials”, authorize scope `https://www.googleapis.com/auth/drive`, exchange for tokens and copy the refresh token. Put the backup folder's id in `GDRIVE_FOLDER_ID` in `wrangler.jsonc`.
5. Secrets (dashboard → Workers → wp-control-hub → Settings → Variables and Secrets, type *Secret*): `ADMIN_PASSWORD`, `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`
6. `npm run deploy`
7. Sign in at `/login` with `ADMIN_PASSWORD`. The login check runs in `worker.ts` in front of every page and action
   (`/api/report` is left open; it checks each site's HMAC signature instead). Changing the password signs everyone out.
   Recommended: a Cloudflare WAF rate-limit rule on `POST /login`.
8. Old backups are never deleted automatically: clean the Drive folder now and then.

## Adding a site

1. Dashboard → enter the site's https URL → Add site
2. Install `wp-plugin/wp-control-hub` on the site (zip the folder, upload via Plugins → Add New)
3. WordPress → Settings → Control Hub → paste the connection key from the hub's site page
4. Hub site page → set allowed admin usernames → "Check users & updates" to test the link

## Local dev

```bash
npm run db:init:local
```

Create `.dev.vars` with `ADMIN_PASSWORD=...` and the three `GDRIVE_*` secrets, then `npm run dev`.
`next dev` does not run `worker.ts`, so there is **no login in dev**; use `npm run preview` to test the real login gate. `npm test` checks hub/plugin signature compatibility.
