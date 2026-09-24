// Browser half of @circle-fin/onramp-kit only. The server half (apiKey handling) stays in
// api/onramp-session.js and is never bundled for the page. esbuild inlines zod and the pino
// browser shim so the page keeps loading scripts from its own origin alone.
export { createOnrampKit, KitError, ONRAMP_EVENT_TYPES, ONRAMP_EVENT_CODES } from "@circle-fin/onramp-kit";
