// The Worker's entry point: SNL lookup behind Cloudflare Access. Everything it does is in bridge.js; see the README,
// "Sign-in with Cloudflare Access". An entry module may export only handlers, so this file exports nothing else.
import { makeWorker } from "./bridge.js";

export default makeWorker();
