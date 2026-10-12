// Runs the Cowork bridge as a Vercel function. vercel.json routes every path here, so
// Cowork's exporter can use the deployment's base URL and append /v1/logs itself.
import { bridgeFromEnv } from "../from-env.mjs";

export default bridgeFromEnv({ log: console.log }).handle;
