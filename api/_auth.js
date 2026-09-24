// One wallet signature proves ownership of an address for every server function that needs
// it: the Deck Hand chat (api/chat.js) and the card onramp (api/onramp-session.js). The page
// builds exactly this text; the server re-derives it from the address + issued time and
// checks the signature recovers to the same address. A signature is good for a week.
import { verifyMessage, getAddress } from "ethers";

export const SIGN_TTL_MS = 7 * 24 * 3600 * 1000;

export const signInText = (address, issued) =>
  `A NEW ONE — Deck Hand sign-in\n\nWallet: ${address}\nIssued: ${issued}\n\nThis signature only proves you own this wallet so the deck hand can keep your memory. It costs nothing and moves nothing.`;

// Returns the checksummed address the signature proves, or null.
export function verifyAuth(auth) {
  if (!auth || typeof auth !== "object") return null;
  const { address, issued, signature } = auth;
  if (typeof address !== "string" || typeof issued !== "string" || typeof signature !== "string") return null;
  const t = Date.parse(issued);
  if (!Number.isFinite(t) || Date.now() - t > SIGN_TTL_MS || t - Date.now() > 5 * 60 * 1000) return null;
  let addr;
  try { addr = getAddress(address); } catch { return null; }
  try {
    const rec = verifyMessage(signInText(addr, issued), signature);
    return rec.toLowerCase() === addr.toLowerCase() ? addr : null;
  } catch { return null; }
}
