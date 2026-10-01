import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuditReport,
  calculateEmbeddedEmissions,
  calculateScenario,
  createDemoDocument,
  getExceptions,
  isCalculationCurrent,
} from "../src/domain.js";

const now = new Date("2026-02-14T10:32:00.000Z");
const verifiedDemo = () => {
  const document = createDemoDocument(now);
  for (const field of document.fields) {
    if (["net_mass", "emissions_value"].includes(field.id)) {
      field.status = "verified";
      field.verifiedValue = field.value;
      field.verifiedAt = now.toISOString();
      field.verifiedBy = "Demo auditor";
    }
  }
  return document;
};

test("calculates embedded emissions deterministically from verified values", () => {
  const result = calculateEmbeddedEmissions(verifiedDemo(), now);
  assert.equal(result.result, 1900);
  assert.equal(result.formula, "1,000 × 1.9");
  assert.equal(result.rule.version, "v2026.1");
  assert.deepEqual(result.inputFieldIds, ["net_mass", "emissions_value"]);
});

test("blocks calculation unless every required input is human verified", () => {
  const document = createDemoDocument(now);
  assert.throws(() => calculateEmbeddedEmissions(document, now), /Net mass must be verified first/);
  document.fields.find((field) => field.id === "net_mass").status = "verified";
  document.fields.find((field) => field.id === "net_mass").verifiedValue = "1,000";
  assert.throws(() => calculateEmbeddedEmissions(document, now), /Emission factor must be verified first/);
});

test("rejects invalid numeric values and unsupported units", () => {
  const document = verifiedDemo();
  document.fields.find((field) => field.id === "net_mass").verifiedValue = "not-a-number";
  assert.throws(() => calculateEmbeddedEmissions(document, now), /Net mass must be a positive number/);
  const unsupported = verifiedDemo();
  unsupported.fields.find((field) => field.id === "emissions_value").unit = "kg";
  assert.throws(() => calculateEmbeddedEmissions(unsupported, now), /supported unit/);
});

test("creates a report with field-level source links, rule version, and audit history", () => {
  const document = verifiedDemo();
  document.calculation = calculateEmbeddedEmissions(document, now);
  const events = [{ documentId: document.id, type: "calculation_generated", at: now.toISOString() }];
  const report = buildAuditReport(document, events, now);
  assert.equal(report.document.fields.find((field) => field.id === "emissions_value").sourcePage, 1);
  assert.equal(report.calculation.ruleVersion, "v2026.1");
  assert.equal(report.calculation.result, 1900);
  assert.equal(report.auditEvents.length, 1);
  assert.match(report.disclaimer, /not an official CBAM filing/);
});

test("scenario uses verified mass and never mutates the compliance calculation", () => {
  const document = verifiedDemo();
  const scenario = calculateScenario(document, "1.6");
  assert.equal(scenario.result, 1600);
  assert.match(scenario.status, /not a verified compliance result/);
  assert.equal(document.calculation, null);
});

test("detects stale calculations after a verified input value changes", () => {
  const document = verifiedDemo();
  document.calculation = calculateEmbeddedEmissions(document, now);
  assert.equal(isCalculationCurrent(document), true);
  document.fields.find((field) => field.id === "emissions_value").verifiedValue = "1.8";
  assert.equal(isCalculationCurrent(document), false);
  document.fields.find((field) => field.id === "emissions_value").verifiedValue = "1.9";
  document.fields.find((field) => field.id === "net_mass").verifiedValue = "1000";
  assert.equal(isCalculationCurrent(document), false);
});

test("reports missing CN code and unverified input exceptions", () => {
  const document = createDemoDocument(now);
  document.fields.find((field) => field.id === "CN_code").value = "";
  const exceptions = getExceptions(document);
  assert.ok(exceptions.some((item) => item.startsWith("Missing CN code")));
  assert.ok(exceptions.some((item) => item.includes("requires human verification")));
});
