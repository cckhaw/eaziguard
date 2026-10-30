import assert from "node:assert/strict";
import { test } from "node:test";
import { alertImpact, deriveComponentStatus, overallStatus } from "./status.ts";
import type { ActiveAlert } from "./types.ts";

function alert(partial: Partial<ActiveAlert>): ActiveAlert {
  return {
    name: "X",
    severity: "warning",
    component: "dns",
    state: "firing",
    summary: "",
    description: "",
    activeAt: "2026-01-01T00:00:00Z",
    labels: {},
    ...partial,
  };
}

test("no data and no alerts is unknown", () => {
  assert.equal(deriveComponentStatus("dns", [], false).status, "unknown");
});

test("data and no alerts is ok", () => {
  assert.equal(deriveComponentStatus("dns", [], true).status, "ok");
});

test("firing critical beats firing warning", () => {
  const alerts = [alert({ name: "A", severity: "warning" }), alert({ name: "B", severity: "critical" })];
  const result = deriveComponentStatus("dns", alerts, true);
  assert.equal(result.status, "critical");
  assert.equal(result.worst?.name, "B");
});

test("pending critical is only a warning", () => {
  assert.equal(alertImpact({ severity: "critical", state: "pending" }), "warning");
});

test("info alerts do not colour the component", () => {
  assert.equal(deriveComponentStatus("dns", [alert({ severity: "info" })], true).status, "ok");
});

test("alerts for other components are ignored", () => {
  assert.equal(deriveComponentStatus("dns", [alert({ component: "wifi", severity: "critical" })], true).status, "ok");
});

test("alerts make an otherwise data-less component visible", () => {
  assert.equal(deriveComponentStatus("dns", [alert({ severity: "critical" })], false).status, "critical");
});

test("overall is the worst known status", () => {
  assert.equal(overallStatus(["ok", "unknown", "warning"]), "warning");
  assert.equal(overallStatus(["unknown", "unknown"]), "unknown");
  assert.equal(overallStatus(["ok", "critical", "warning"]), "critical");
});
