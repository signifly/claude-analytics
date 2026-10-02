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
