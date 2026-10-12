// The bridge as configured by the environment: the plugin's CLAUDE_ANALYTICS_LOKI_* variables,
// plus COWORK_BRIDGE_TOKEN, what Cowork sends as `Authorization: Bearer …`.
import { loadConfig } from "../../plugins/usage-analytics/scripts/config.mjs";
import { createLokiSink } from "../../plugins/usage-analytics/scripts/loki-sink.mjs";
import { createBridge } from "./bridge.mjs";

export function bridgeFromEnv({ env = process.env, log }) {
  const { loki, warnings } = loadConfig(env);
  for (const warning of warnings) log(warning);
  return { loki, handle: createBridge({ token: env.COWORK_BRIDGE_TOKEN, sink: createLokiSink({ ...loki, log }), log }) };
}
