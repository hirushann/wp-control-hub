# WP Control Hub

Next.js dashboard on Cloudflare Workers (OpenNext + D1 + Cron) that manages many WordPress sites through the
`wp-plugin/wp-control-hub` connector plugin.

| Feature | How |
|---|---|
| Malware scan every 2 days | Plugin checks core files against wordpress.org checksums, PHP in uploads, unknown files in core dirs, and known malicious code patterns |
| Daily admin account check | Plugin lists administrators; hub flags more than `MAX_ADMINS` or anyone not in the site's allowed list |
| Daily backup to OVH | Plugin zips files + DB dump and PUTs it to OVH Object Storage via a presigned URL (the plugin never holds OVH keys) |
| Daily updates with rollback | After the backup, plugin updates core/plugins/themes, loads the home page and login page, and restores the backup automatically if either fails |
| Manual rollback / remote restore | Site page → Backups → Restore (backups taken before updates are marked "pre-update") |

Flow: hub sends a signed command → plugin queues it in WP-Cron and replies 202 → when done, plugin POSTs a signed report to `/api/report`.
Both directions use HMAC-SHA256 with a per-site secret and a 5-minute timestamp window.

## Setup

1. `npm install`
2. `npx wrangler d1 create wp-control-hub` and put the `database_id` in `wrangler.jsonc`
3. `npm run db:init`
4. Set the `OVH_S3_*` vars in `wrangler.jsonc` (OVH: create an S3 user + bucket in Public Cloud → Object Storage)
5. `npx wrangler secret put ADMIN_PASSWORD`, `npx wrangler secret put OVH_S3_ACCESS_KEY` and `npx wrangler secret put OVH_S3_SECRET_KEY`
6. `npm run deploy`
7. Sign in at `/login` with `ADMIN_PASSWORD`. The login check runs in `worker.ts` in front of every page and action
   (`/api/report` is left open; it checks each site's HMAC signature instead). Changing the password signs everyone out.
   Recommended: a Cloudflare WAF rate-limit rule on `POST /login`.
8. Optional: an OVH bucket lifecycle rule to delete old backups (the hub keeps none of its own retention).

## Adding a site

1. Dashboard → enter the site's https URL → Add site
2. Install `wp-plugin/wp-control-hub` on the site (zip the folder, upload via Plugins → Add New)
3. WordPress → Settings → Control Hub → paste the connection key from the hub's site page
4. Hub site page → set allowed admin usernames → "Check users & updates" to test the link

## Local dev

```bash
npm run db:init:local
```

Create `.dev.vars` with `ADMIN_PASSWORD=...`, `OVH_S3_ACCESS_KEY=...` and `OVH_S3_SECRET_KEY=...`, then `npm run dev`.
`next dev` does not run `worker.ts`, so there is **no login in dev**; use `npm run preview` to test the real login gate. `npm test` checks hub/plugin signature compatibility.
