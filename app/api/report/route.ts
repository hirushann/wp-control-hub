import { getCloudflareContext } from "@opennextjs/cloudflare";
import { type Env, getSite, insertReport, REPORT_TYPES, verify } from "@/lib/hub";

// Plugin → hub. Must be reachable without Cloudflare Access (add a bypass rule for /api/report).
export async function POST(req: Request) {
  const env = getCloudflareContext().env as Env;
  const site = await getSite(env, req.headers.get("x-wpch-site") ?? "");
  const body = await req.text();
  if (!site || !(await verify(site.secret, req.headers.get("x-wpch-ts") ?? "", body, req.headers.get("x-wpch-sig") ?? ""))) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { type, ok, data } = JSON.parse(body);
  if (!REPORT_TYPES.includes(type)) return new Response("Bad type", { status: 400 });
  await insertReport(env, site.id, type, Boolean(ok), data ?? {});
  return new Response(null, { status: 204 });
}
