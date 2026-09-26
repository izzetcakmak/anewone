// The one piece of shared state the functions have: an Upstash Redis (Frankfurt), reached
// over its REST face so no client library is needed. The Vercel integration sets
// KV_REST_API_URL / KV_REST_API_TOKEN; without them every helper reports "not available"
// and the callers fall back to what they did before (in-memory counters, signature auth).
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const kvAvailable = () => !!(URL_ && TOKEN);

/** One command, e.g. kv("SET", "k", "v", "EX", 60). Throws on transport or Redis errors. */
export async function kv(...cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
    signal: AbortSignal.timeout(2500),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("kv: " + (j.error || r.status));
  return j.result;
}

/** Several commands in one round trip; returns their results in order. */
export async function kvPipeline(cmds) {
  const r = await fetch(URL_.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
    signal: AbortSignal.timeout(2500),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error("kv pipeline: " + r.status);
  for (const x of j) if (x && x.error) throw new Error("kv pipeline: " + x.error);
  return j.map((x) => x.result);
}
