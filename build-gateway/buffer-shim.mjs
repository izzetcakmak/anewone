// The kit encodes burn intents with Node's Buffer; the browser has none, so the bundle gets
// the npm "buffer" package wherever the code names Buffer (esbuild inject).
export { Buffer } from "buffer";
