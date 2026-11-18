import { getCloudflareContext } from "@opennextjs/cloudflare";
import { driveToken, type Env, getSite, siteOwnsBackup, verify } from "@/lib/hub";

// Plugin → hub during a restore: streams the site's own backup zip from Google Drive.
// Signed like /api/report, with the file id as the signed body.
export async function GET(req: Request) {
  const env = getCloudflareContext().env as Env;
  const file = new URL(req.url).searchParams.get("file") ?? "";
  const site = await getSite(env, req.headers.get("x-wpch-site") ?? "");
  if (!site || !file || !(await verify(site.secret, req.headers.get("x-wpch-ts") ?? "", file, req.headers.get("x-wpch-sig") ?? ""))) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!(await siteOwnsBackup(env, site.id, file))) return new Response("Not found", { status: 404 });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file)}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${await driveToken(env)}` },
  });
  if (!res.ok) return new Response(`Google Drive: HTTP ${res.status}`, { status: 502 });
  const headers = new Headers({ "content-type": "application/zip" });
  const len = res.headers.get("content-length");
  if (len) headers.set("content-length", len);
  return new Response(res.body, { headers });
}
