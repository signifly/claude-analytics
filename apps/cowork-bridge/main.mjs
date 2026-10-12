// Runs the Cowork bridge. Configuration is the plugin's CLAUDE_ANALYTICS_LOKI_* variables,
// plus COWORK_BRIDGE_TOKEN (what Cowork sends as `Authorization: Bearer …`) and PORT.
import http from "node:http";
import { loadConfig } from "../../plugins/usage-analytics/scripts/config.mjs";
import { createLokiSink } from "../../plugins/usage-analytics/scripts/loki-sink.mjs";
import { createBridge } from "./bridge.mjs";

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
const config = loadConfig();
for (const warning of config.warnings) log(warning);

const bridge = createBridge({ token: process.env.COWORK_BRIDGE_TOKEN, sink: createLokiSink({ ...config.loki, log }), log });
const port = Number(process.env.PORT) || 4318;
http.createServer(bridge).listen(port, () => log(`cowork bridge listening on :${port}, pushing to ${config.loki.url}`));
