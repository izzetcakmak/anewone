// One wallet signature proves ownership of an address for the server functions that need it:
// the Deck Hand chat (api/chat.js) and the card onramp (api/onramp-session.js). The message is
// Sign-In with Ethereum (EIP-4361): it names the site, the chain, a nonce the page draws at
// random, when it was issued and when it expires, and says in plain words the two things it
// is used for. The page builds exactly this text; the server re-derives it from the address,
// nonce and issued time and checks the signature recovers to the same address.
//
// With Redis (api/_kv.js) the signature is shown once to api/auth.js, which burns the nonce
// and hands back a random session token good for a day; the page then sends only the token.
// Without Redis the signature itself is the credential, for the same day.
import { verifyMessage, getAddress } from "ethers";
import { randomBytes } from "node:crypto";
import { kv, kvAvailable } from "./_kv.js";

export const SIGN_TTL_MS = 24 * 3600 * 1000;
export const SESSION_TTL_S = 24 * 3600;
const DOMAIN = "anewone.xyz";
const URI = "https://anewone.xyz";
const CHAIN_ID = 5042;

export const signInText = (address, nonce, issued) => {
  const expires = new Date(Date.parse(issued) + SIGN_TTL_MS).toISOString();
  return `${DOMAIN} wants you to sign in with your Ethereum account:\n${address}\n\n` +
    `Sign in to A NEW ONE. This signature proves you own this wallet for two things only: keeping your Deck Hand memory, and opening card purchases that land in this wallet. It costs nothing, moves nothing, and cannot spend from the wallet.\n\n` +
    `URI: ${URI}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${nonce}\nIssued At: ${issued}\nExpiration Time: ${expires}`;
};

const NONCE_RE = /^[A-Za-z0-9]{8,64}$/;

/** The checksummed address a signed message proves, or null. */
export function verifySignature(auth) {
  if (!auth || typeof auth !== "object") return null;
  const { address, nonce, issued, signature } = auth;
  if ([address, nonce, issued, signature].some((x) => typeof x !== "string")) return null;
  if (!NONCE_RE.test(nonce)) return null;
  const t = Date.parse(issued);
  if (!Number.isFinite(t) || Date.now() - t > SIGN_TTL_MS || t - Date.now() > 5 * 60 * 1000) return null;
  let addr;
  try { addr = getAddress(address); } catch { return null; }
  try {
    const rec = verifyMessage(signInText(addr, nonce, issued), signature);
    return rec.toLowerCase() === addr.toLowerCase() ? addr : null;
  } catch { return null; }
}

/**
 * The address behind a request's `auth`: a session token when Redis holds one, otherwise a
 * signed message. Returns null for anything else, including a token Redis no longer has.
 */
export async function verifyAuth(auth) {
  if (auth && typeof auth === "object" && typeof auth.session === "string") {
    if (!kvAvailable() || !/^[a-f0-9]{64}$/.test(auth.session)) return null;
    try {
      const addr = await kv("GET", "sess:" + auth.session);
      return addr ? getAddress(addr) : null;
    } catch { return null; }
  }
  return verifySignature(auth);
}

/**
 * Trades a signed message for a session token. The nonce is burned for as long as the
 * signature could be valid, so the same signature cannot open a second session. Without
 * Redis there is nothing to store a session in, and the page keeps using the signature.
 */
export async function issueSession(auth) {
  const address = verifySignature(auth);
  if (!address) return { error: "bad signature" };
  if (!kvAvailable()) return { address, session: null };
  const fresh = await kv("SET", `nonce:${address.toLowerCase()}:${auth.nonce}`, "1", "EX", Math.ceil(SIGN_TTL_MS / 1000), "NX");
  if (fresh !== "OK") return { error: "signature already used" };
  const session = randomBytes(32).toString("hex");
  await kv("SET", "sess:" + session, address, "EX", SESSION_TTL_S);
  return { address, session, expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000).toISOString() };
}

/** Ends a session early (sign-out). */
export async function endSession(auth) {
  if (!kvAvailable() || !auth || typeof auth.session !== "string") return;
  try { await kv("DEL", "sess:" + auth.session); } catch {}
}
