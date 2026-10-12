import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard = JSON.parse(readFileSync(new URL("../stack/grafana/dashboards/claude-code-usage.json", import.meta.url)));

test("the dashboard picks its Loki through a variable, so it imports into a Grafana whose Loki has another uid", () => {
  const variable = dashboard.templating.list[0];
  assert.equal(variable.name, "datasource");
  assert.equal(variable.type, "datasource");
  assert.equal(variable.query, "loki");

  const uids = [];
  JSON.stringify(dashboard, (key, value) => (key === "datasource" && value?.uid && uids.push(value.uid), value));
  assert.ok(uids.length > 0);
  assert.deepEqual(new Set(uids), new Set(["${datasource}"]));
});

test("the Loki picker leaves out Grafana Cloud's internal Loki data sources", () => {
  const { regex } = dashboard.templating.list[0];
  const [, body, flags] = regex.match(/^\/(.*)\/(\w*)$/);
  const offered = (name) => new RegExp(body, flags).test(name);
  assert.ok(offered("Loki"));
  assert.ok(offered("grafanacloud-signifly-logs"));
  assert.ok(!offered("grafanacloud-signifly-alert-state-history"));
  assert.ok(!offered("grafanacloud-signifly-usage-insights"));
  // Grafana 13 matches the regex against the uid too, which has no stack name in it.
  assert.ok(offered("grafanacloud-logs"));
  assert.ok(!offered("grafanacloud-alert-state-history"));
  assert.ok(!offered("grafanacloud-usage-insights"));
});

test("every bar gauge draws one bar per row, so one table frame (Grafana 13's Loki) shows every value, not the last", () => {
  const gauges = dashboard.panels.filter((panel) => panel.type === "bargauge");
  assert.ok(gauges.length > 0);
  for (const panel of gauges) assert.equal(panel.options.reduceOptions.values, true, panel.title);
});
