// Runs the Cowork bridge as a long-lived server (the Docker image). PORT defaults to 4318.
import http from "node:http";
import { bridgeFromEnv } from "./from-env.mjs";

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const { loki, handle } = bridgeFromEnv({ log });
const port = Number(process.env.PORT) || 4318;
http.createServer(handle).listen(port, () => log(`cowork bridge listening on :${port}, pushing to ${loki.url}`));
