// Per-IP rate limiting shared by every function. The counters live in Redis (api/_kv.js),
// so they survive across serverless instances and cold starts; without Redis, or when it
// does not answer in time, a per-instance counter takes over, which is what the functions
// had before. Neither is a security boundary: everything behind them is public or signed.
// A cost guard fails open, never closed.
import { kv, kvPipeline, kvAvailable } from "./_kv.js";

const local = new Map();
function limitedLocally(key, max, windowSec) {
  const now = Date.now(), w = local.get(key) || [];
  const recent = w.filter((t) => now - t < windowSec * 1000);
  recent.push(now); local.set(key, recent);
  if (local.size > 5000) local.clear(); // a warm instance never hoards addresses
  return recent.length > max;
}

// Once Redis has said a caller is over the limit, this instance knows the answer until that
// window closes and stops asking: a flood at one function must not drain the Redis command
// quota that sessions and every other function share. Windows are aligned to the clock, so
// every instance knows when the current one closes without asking Redis for a TTL.
const over = new Map(); // "rl:scope:ip" -> ms at which the window it went over in closes

/** The caller's IP as Vercel presents it. */
export function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?";
}

/**
 * True when `ip` has made more than `max` calls to `scope` in the current fixed window of
 * `windowSec` seconds. One INCR and one EXPIRE per call, in a single round trip, and none at
 * all for a caller this instance already knows to be over.
 */
export async function limited(scope, ip, max, windowSec = 60) {
  const key = `rl:${scope}:${ip}`;
  const now = Date.now(), w = windowSec * 1000;
  const until = over.get(key);
  if (until > now) return true;
  if (until) over.delete(key);
  if (kvAvailable()) {
    const win = Math.floor(now / w);
    const wkey = `${key}:${win}`;
    try {
      const [n] = await kvPipeline([["INCR", wkey], ["EXPIRE", wkey, windowSec, "NX"]]);
      if (Number(n) <= max) return false;
      if (over.size >= 5000) over.clear(); // a warm instance never hoards addresses
      over.set(key, (win + 1) * w);
      return true;
    } catch {
      // Redis unreachable: the instance counter below carries on
    }
  }
  return limitedLocally(key, max, windowSec);
}

/** Answers 429 and returns true when the caller is over the limit; the handler returns. */
export async function tooMany(req, res, scope, max, windowSec = 60) {
  if (!(await limited(scope, clientIp(req), max, windowSec))) return false;
  res.setHeader("Retry-After", String(windowSec));
  res.status(429).json({ error: "slow down a little", message: "slow down a little" });
  return true;
}

export { kv };
