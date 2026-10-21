// The community vote on how the Ecosystem Budget is spent (page: docs/fun/vote.js).
// Not a function of its own (the leading underscore keeps it out of the count: the plan caps
// them): api/ack.js hands /api/vote to this behind a rewrite, after its origin check.
//
// Walletless on purpose, so it is a signal, not a binding onchain vote. One vote per browser
// (a random id the page keeps), changeable until the window closes, and at most MAX_PER_NET
// browsers per network so a household or an office is fine but a script is not. The network
// address is stored only as a keyed hash, to stop duplicates, and expires with the poll.
//
//   GET  /api/vote            -> { poll, open, opensAt, closesAt, counts, total }   (CDN-cached 30 s)
//   POST /api/vote {voter, choice} -> the same, plus { mine }
import { createHmac } from "node:crypto";
import { kv, kvPipeline, kvAvailable } from "./_kv.js";
import { tooMany, clientIp } from "./_ratelimit.js";

export const POLL = {
  // a preview deployment shares production's Redis, so its votes get their own poll and never reach the real count
  id: process.env.VERCEL_ENV === "preview" ? "ecosystem-budget-2026-10-draft" : "ecosystem-budget-2026-10",
  // opens 22 Oct 12:00 Türkiye time, runs two days; a preview (the rehearsal) is open from the start
  opensAt: process.env.VERCEL_ENV === "preview" ? 0 : Date.parse("2026-10-22T09:00:00Z"),
  closesAt: Date.parse("2026-10-24T09:00:00Z"),
  choices: ["no", "alternating", "hybrid", "classic"], // "no" = refused the program at step 1
};
const MAX_PER_NET = 5;
const TTL = 60 * 24 * 3600;
const VOTES = `poll:${POLL.id}:votes`, COUNTS = `poll:${POLL.id}:counts`;
const netKey = (ip) =>
  `poll:${POLL.id}:net:` + createHmac("sha256", process.env.VOTE_SALT || process.env.KV_REST_API_TOKEN || "preview").update(ip).digest("hex").slice(0, 24);

// Without Redis a deployed function must say so; only a local preview may keep votes in memory.
const memory = !kvAvailable() && !process.env.VERCEL;
const mem = { votes: new Map(), nets: new Map() };

function shape(raw) {
  const counts = Object.fromEntries(POLL.choices.map((c) => [c, Math.max(0, Number(raw[c]) || 0)]));
  return { poll: POLL.id, open: Date.now() >= POLL.opensAt && Date.now() < POLL.closesAt, opensAt: new Date(POLL.opensAt).toISOString(), closesAt: new Date(POLL.closesAt).toISOString(), counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

async function readCounts() {
  if (memory) {
    const raw = {};
    for (const c of mem.votes.values()) raw[c] = (raw[c] || 0) + 1;
    return raw;
  }
  const flat = await kv("HGETALL", COUNTS); // Upstash answers a flat [field, value, ...] list
  const raw = {};
  if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) raw[flat[i]] = flat[i + 1];
  return raw;
}

export default async function vote(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    if (!memory && !kvAvailable()) return res.status(503).json({ error: "voting is not available right now" });
    try {
      const out = shape(await readCounts());
      res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60"); // the Redis quota is shared
      return res.status(200).json(out);
    } catch { return res.status(503).json({ error: "voting is not available right now" }); }
  }
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "method" }); }

  if (Date.now() < POLL.opensAt) return res.status(403).json({ error: "voting has not opened yet" });
  if (Date.now() >= POLL.closesAt) return res.status(410).json({ error: "voting has closed" });
  if (!memory && !kvAvailable()) return res.status(503).json({ error: "voting is not available right now" });
  if (await tooMany(req, res, "vote-post", 12, 600)) return;
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const { voter, choice } = b;
  if (typeof voter !== "string" || !/^[a-f0-9]{32}$/.test(voter) || !POLL.choices.includes(choice)) return res.status(400).json({ error: "bad request" });

  const ip = clientIp(req);
  try {
    if (memory) {
      const prev = mem.votes.get(voter);
      const net = mem.nets.get(ip) || new Set();
      if (!prev && !net.has(voter) && net.size >= MAX_PER_NET) return res.status(429).json({ error: "too many votes from this network" });
      net.add(voter); mem.nets.set(ip, net); mem.votes.set(voter, choice);
    } else {
      const prev = await kv("HGET", VOTES, voter);
      if (!prev) { // a new voter: count them against their network first
        const nk = netKey(ip);
        const [, size] = await kvPipeline([["SADD", nk, voter], ["SCARD", nk], ["EXPIRE", nk, TTL]]).then((r) => [r[0], Number(r[1])]);
        if (size > MAX_PER_NET) { await kv("SREM", nk, voter).catch(() => {}); return res.status(429).json({ error: "too many votes from this network" }); }
      }
      if (prev !== choice) {
        const cmds = [["HSET", VOTES, voter, choice], ["HINCRBY", COUNTS, choice, 1], ["EXPIRE", VOTES, TTL], ["EXPIRE", COUNTS, TTL]];
        if (prev && POLL.choices.includes(prev)) cmds.push(["HINCRBY", COUNTS, prev, -1]);
        await kvPipeline(cmds);
      }
    }
    return res.status(200).json({ ...shape(await readCounts()), mine: choice });
  } catch {
    return res.status(503).json({ error: "voting is not available right now" });
  }
}
