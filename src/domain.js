export const RULE = Object.freeze({
  ruleId: "EMBEDDED_EMISSIONS",
  ruleName: "Embedded emissions",
  version: "v2026.1",
  formula: "net_mass × emission_factor",
  effectiveDate: "2026-01-01",
  sector: "Iron and steel",
  inputs: ["net_mass", "emissions_value"],
});

export const FIELD_DEFINITIONS = Object.freeze([
  { id: "supplier_name", label: "Supplier", unit: "", required: false },
  { id: "country", label: "Country", unit: "", required: false },
  { id: "product", label: "Product", unit: "", required: false },
  { id: "CN_code", label: "CN code", unit: "", required: false },
  { id: "net_mass", label: "Net mass", unit: "t", required: true },
  { id: "emissions_value", label: "Emission factor", unit: "tCO₂e/t", required: true },
]);

export function createDemoDocument(now = new Date()) {
  const values = {
    supplier_name: ["Demo Steel Supplier", "", 99, [84, 197], "Supplier: Demo Steel Supplier"],
    country: ["India", "", 98, [84, 222], "Country of origin: India"],
    product: ["Steel Coil", "", 99, [84, 273], "Product: Hot rolled steel coil"],
    CN_code: ["7208.39 (demo)", "", 96, [84, 310], "CN code: 7208.39 (illustrative)"],
    net_mass: ["1,000", "t", 97, [294, 370], "Net mass: 1,000 t"],
    emissions_value: ["1.9", "tCO₂e/t", 94, [294, 398], "Specific embedded emissions: 1.9 tCO2e/t"],
  };
  const fields = FIELD_DEFINITIONS.map((definition) => {
    const [value, unit, confidence, coordinates, sourceText] = values[definition.id];
    return {
      ...definition,
      value,
      unit,
      confidence,
      page: 1,
      coordinates: { x: coordinates[0], y: coordinates[1] },
      sourceText,
      status: "pending",
      verifiedValue: null,
      verifiedAt: null,
      verifiedBy: null,
    };
  });
  return {
    id: "demo-invoice",
    fileName: "demo_supplier_invoice.pdf",
    documentType: "Supplier invoice · Illustrative sample",
    uploadedAt: now.toISOString(),
    processingStatus: "Extraction complete · demo fallback",
    isDemo: true,
    fields,
    calculation: null,
  };
}

function parseFiniteNumber(value, label) {
  const normalized = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return normalized;
}

export function getVerifiedInput(document, fieldId) {
  const field = document?.fields?.find((candidate) => candidate.id === fieldId);
  if (!field || field.status !== "verified" || field.verifiedValue == null || field.verifiedValue === "") {
    throw new Error(`${FIELD_DEFINITIONS.find((item) => item.id === fieldId)?.label ?? fieldId} must be verified first.`);
  }
  return field;
}

export function calculateEmbeddedEmissions(document, executedAt = new Date()) {
  const massField = getVerifiedInput(document, "net_mass");
  const factorField = getVerifiedInput(document, "emissions_value");
  if (massField.unit !== "t") throw new Error("Net mass must use the supported unit t.");
  if (factorField.unit !== "tCO₂e/t") throw new Error("Emission factor must use the supported unit tCO₂e/t.");

  const netMass = parseFiniteNumber(massField.verifiedValue, "Net mass");
  const emissionFactor = parseFiniteNumber(factorField.verifiedValue, "Emission factor");
  const result = Number((netMass * emissionFactor).toFixed(6));
  return {
    id: `calc-${Date.parse(executedAt)}`,
    rule: { ...RULE },
    inputFieldIds: [massField.id, factorField.id],
    verifiedInputValues: [
      { fieldId: massField.id, value: String(massField.verifiedValue), unit: massField.unit },
      { fieldId: factorField.id, value: String(factorField.verifiedValue), unit: factorField.unit },
    ],
    netMass,
    emissionFactor,
    formula: `${formatNumber(netMass)} × ${formatNumber(emissionFactor)}`,
    result,
    unit: "tCO₂e",
    executedAt: executedAt.toISOString(),
    status: "verified-input calculation",
  };
}

export function isCalculationCurrent(document) {
  if (!document?.calculation) return true;
  try {
    const massField = getVerifiedInput(document, "net_mass");
    const factorField = getVerifiedInput(document, "emissions_value");
    return String(massField.verifiedValue) === document.calculation.verifiedInputValues?.[0]?.value
      && massField.unit === document.calculation.verifiedInputValues?.[0]?.unit
      && String(factorField.verifiedValue) === document.calculation.verifiedInputValues?.[1]?.value
      && factorField.unit === document.calculation.verifiedInputValues?.[1]?.unit
      && parseFiniteNumber(massField.verifiedValue, "Net mass") === document.calculation.netMass
      && parseFiniteNumber(factorField.verifiedValue, "Emission factor") === document.calculation.emissionFactor;
  } catch {
    return false;
  }
}

export function calculateScenario(document, proposedFactor) {
  const massField = getVerifiedInput(document, "net_mass");
  if (massField.unit !== "t") throw new Error("Net mass must use the supported unit t.");
  const netMass = parseFiniteNumber(massField.verifiedValue, "Net mass");
  const emissionFactor = parseFiniteNumber(proposedFactor, "Scenario emission factor");
  return {
    netMass,
    emissionFactor,
    result: Number((netMass * emissionFactor).toFixed(6)),
    unit: "tCO₂e",
    status: "Scenario / What-if — not a verified compliance result",
  };
}

export function getExceptions(document) {
  if (!document) return [];
  const exceptions = [];
  const byId = (id) => document.fields.find((field) => field.id === id);
  const cnCode = byId("CN_code");
  const mass = byId("net_mass");
  const factor = byId("emissions_value");
  if (!cnCode || !String(cnCode.verifiedValue ?? cnCode.value ?? "").trim()) {
    exceptions.push("Missing CN code — add or verify a code.");
  }
  if (!factor || !String(factor.verifiedValue ?? factor.value ?? "").trim()) {
    exceptions.push("Missing emission factor.");
  }
  for (const [field, label] of [[mass, "Net mass"], [factor, "Emission factor"]]) {
    if (!field) continue;
    const raw = field.status === "verified" ? field.verifiedValue : field.value;
    if (raw !== "" && raw != null && (!Number.isFinite(Number(String(raw).replace(/,/g, "").trim())) || Number(raw) <= 0)) {
      exceptions.push(`Invalid numeric value — ${label}.`);
    }
    if (field.id === "net_mass" && field.unit !== "t") exceptions.push("Unsupported unit — net mass must be in t.");
    if (field.id === "emissions_value" && field.unit !== "tCO₂e/t") exceptions.push("Unsupported unit — emission factor must be in tCO₂e/t.");
  }
  for (const id of RULE.inputs) {
    const field = byId(id);
    if (field && field.status !== "verified" && !exceptions.some((exception) => exception.startsWith(id === "net_mass" ? "Missing net mass" : "Missing emission factor"))) {
      exceptions.push(`${FIELD_DEFINITIONS.find((item) => item.id === id).label} requires human verification.`);
    }
  }
  return [...new Set(exceptions)];
}

export function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);
}

export function buildAuditReport(document, events, generatedAt = new Date()) {
  if (!document) throw new Error("There is no document to include in the audit report.");
  return {
    report: "CBAM-AuditTrace audit record",
    disclaimer: "Illustrative sample only — not an official CBAM filing. Verify against current official CBAM guidance before compliance use.",
    generatedAt: generatedAt.toISOString(),
    document: {
      id: document.id,
      fileName: document.fileName,
      documentType: document.documentType,
      uploadedAt: document.uploadedAt,
      supplier: document.fields.find((field) => field.id === "supplier_name")?.verifiedValue ?? document.fields.find((field) => field.id === "supplier_name")?.value ?? null,
      fields: document.fields.map((field) => ({
        id: field.id,
        label: field.label,
        proposedValue: field.value,
        verifiedValue: field.verifiedValue,
        unit: field.unit,
        verificationStatus: field.status,
        verifiedAt: field.verifiedAt,
        verifiedBy: field.verifiedBy,
        sourcePage: field.page,
        sourceCoordinates: field.coordinates,
        sourceText: field.sourceText,
        confidence: field.confidence,
      })),
    },
    calculation: document.calculation ? {
      ruleId: document.calculation.rule.ruleId,
      ruleVersion: document.calculation.rule.version,
      formula: document.calculation.rule.formula,
      substitutedFormula: document.calculation.formula,
      inputFieldIds: document.calculation.inputFieldIds,
      verifiedInputValues: document.calculation.verifiedInputValues,
      netMass: document.calculation.netMass,
      emissionFactor: document.calculation.emissionFactor,
      result: document.calculation.result,
      unit: document.calculation.unit,
      executedAt: document.calculation.executedAt,
    } : null,
    auditEvents: events.filter((event) => event.documentId === document.id),
  };
}
