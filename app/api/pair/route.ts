import { getCloudflareContext } from "@opennextjs/cloudflare";
import { deliverKey, type Env, findPairable } from "@/lib/hub";

// Site → hub, unauthenticated by design: see the pairing notes in lib/hub.ts. Public in worker.ts.
export async function POST(req: Request) {
  const { env, ctx } = getCloudflareContext();
  const { url, nonce } = (await req.json().catch(() => ({}))) as { url?: unknown; nonce?: unknown };
  if (typeof url !== "string" || typeof nonce !== "string" || !/^[a-f0-9]{32,64}$/.test(nonce)) {
    return Response.json({ message: "Expected {url, nonce}" }, { status: 400 });
  }
  const r = await findPairable(env as Env, url);
  if ("message" in r) return Response.json({ message: r.message }, { status: r.status });
  // answer now: the key goes out in a second request to the site, which may not take two PHP requests at once
  ctx.waitUntil(deliverKey(env as Env, new URL(req.url).origin, r.site, nonce));
  return Response.json({ message: "Pairing started" }, { status: 202 });
}
