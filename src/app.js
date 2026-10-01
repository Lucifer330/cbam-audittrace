import {
  FIELD_DEFINITIONS,
  buildAuditReport,
  calculateEmbeddedEmissions,
  calculateScenario,
  formatNumber,
  getExceptions,
  isCalculationCurrent,
} from "./domain.js";
import { extractDocument } from "./extraction.js";
import { createSamplePdfDataUrl, fileToDataUrl } from "./pdf.js";

const STORAGE_KEY = "cbam-audittrace-state-v1";
const content = document.querySelector("#app-content");
const modalRoot = document.querySelector("#modal-root");
const toastRoot = document.querySelector("#toast-root");
let samplePdfDataUrl = null;
const uploadDataByDocId = new Map();
let editingFieldId = null;
let focusedFieldId = null;
let backendSecurity = null;
let inlineTraceOpen = false;
let pdfReportDocumentId = null;

const ICON_PATHS = Object.freeze({
  grid: `<rect x="3.5" y="3.5" width="7" height="7"/><rect x="13.5" y="3.5" width="7" height="7"/><rect x="3.5" y="13.5" width="7" height="7"/><rect x="13.5" y="13.5" width="7" height="7"/>`,
  document: `<path d="M6 2.75h8l4 4v14.5H6z"/><path d="M14 2.75v4h4M9 12h6M9 16h6"/>`,
  check: `<path d="m5 12 4 4L19 6"/>`,
  calculator: `<rect x="4" y="2.75" width="16" height="18.5" rx="1"/><path d="M7.5 6.5h9v4h-9zM8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01M16 17.5h.01"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  rules: `<path d="M4 4.5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"/><path d="M4 17.5a2 2 0 0 1 2-2h12M8 7h6M8 10.5h6"/>`,
  report: `<path d="M5 3h14v18H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>`,
  settings: `<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.1 1.9-2 3.4-2.2-.5-.2.1-1.2 1.5h-4l-1.2-1.5-.2-.1-2.2.5-2-3.4 1.1-1.9.1-.2v-2.1l-.1-.2-1.1-1.9 2-3.4 2.2.5.2-.1L11 6.1h4l1.2 1.5.2.1 2.2-.5 2 3.4-1.1 1.9-.1.2z"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  info: `<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/>`,
  search: `<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/>`,
  upload: `<path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 14v6h16v-6"/>`,
  alert: `<path d="M12 3 2.8 20h18.4z"/><path d="M12 9v4M12 16.5h.01"/>`,
  arrowUpRight: `<path d="M7 17 17 7M8 7h9v9"/>`,
});

function uiIcon(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] ?? ICON_PATHS.document}</svg>`;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && Array.isArray(saved.documents) && Array.isArray(saved.events)) {
      return { page: "dashboard", documents: saved.documents, events: saved.events, activeDocId: saved.activeDocId ?? null };
    }
  } catch (error) {
    console.error("Unable to restore the local workspace.", error);
  }
  return { page: "dashboard", documents: [], events: [], activeDocId: null };
}

const state = loadState();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      documents: state.documents,
      events: state.events,
      activeDocId: state.activeDocId,
    }));
    document.querySelector(".local-status").innerHTML = "<i></i> All changes saved";
  } catch (error) {
    document.querySelector(".local-status").innerHTML = "<i></i> Saved for this session";
    console.error("Workspace storage is full; changes are available for this session only.", error);
    toast("Browser storage is full. Your current session is still available.", true);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function currentDocument() {
  return state.documents.find((document) => document.id === state.activeDocId) ?? null;
}

function addEvent(type, description, documentId = currentDocument()?.id ?? null, related = "", persistToServer = true, serverEventId = null) {
  const activity = {
    id: serverEventId ?? `event-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    at: new Date().toISOString(),
    type,
    description,
    user: "Demo auditor",
    documentId,
    related,
    documentReference: state.documents.find((document) => document.id === documentId)?.fileName ?? null,
  };
  state.events.push(activity);
  if (!persistToServer) return;
  fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_id: documentId,
      event_type: type,
      actor: activity.user,
      detail: related || description,
    }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Audit API returned ${response.status}`);
    const result = await response.json();
    activity.id = result.event_id;
    persist();
  }).catch((error) => {
    console.error("Could not persist the audit event to the API.", error);
    toast("The action is saved locally, but its server audit event could not be recorded.", true);
  });
}

function toast(message, isError = false) {
  const element = document.createElement("div");
  element.className = `toast${isError ? " error" : ""}`;
  element.textContent = message;
  toastRoot.append(element);
  window.setTimeout(() => element.remove(), 3300);
}

function formatDate(value, options = {}) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short", day: "numeric", year: "numeric", ...options,
  }).format(date);
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function statusBadge(status) {
  const labels = { unverified: "Unverified", pending: "Pending review", verified: "Verified", rejected: "Rejected" };
  const mark = status === "verified"
    ? `<svg class="state-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.2 3 3 6-6.4"/></svg>`
    : status === "pending" ? "!" : status === "rejected" ? "×" : "—";
  return `<span class="status-badge state-${status}"><span class="state-mark" aria-hidden="true">${mark}</span>${labels[status] ?? "Unverified"}</span>`;
}

function pageHeading(eyebrow, title, subtitle, action = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div>${action}</div>`;
}

function metricCard(label, value, foot, icon) {
  return `<div class="metric-card"><div class="metric-label">${label}<span class="metric-icon">${uiIcon(icon)}</span></div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></div>`;
}

function getStats() {
  const docs = state.documents;
  const pending = docs.reduce((sum, doc) => sum + doc.fields.filter((field) => field.status === "pending").length, 0);
  const calculations = docs.filter((doc) => doc.calculation).length;
  const auditReady = docs.filter((doc) => doc.calculation && doc.fields.length > 0 && doc.fields.every((field) => field.status === "verified")).length;
  const exceptions = docs.reduce((sum, doc) => sum + getExceptions(doc).length, 0);
  return { documents: docs.length, pending, calculations, auditReady, exceptions };
}

function renderDashboard() {
  const stats = getStats();
  const recentDocuments = [...state.documents].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).slice(0, 5);
  const recentCalculations = state.documents.filter((doc) => doc.calculation).slice(-4).reverse();
  const uploadButton = `<button class="primary-button" data-action="trigger-upload"><span class="button-icon">${uiIcon("plus")}</span> Upload supplier document</button>`;
  const documentRows = recentDocuments.map((doc) => {
    const pending = doc.fields.some((field) => field.status === "pending");
    return `<tr data-open-document="${escapeHtml(doc.id)}"><td><div class="file-cell"><span class="file-icon">PDF</span><span>${escapeHtml(doc.fileName)}<small>${escapeHtml(doc.documentType)}</small></span></div></td><td>${formatDate(doc.uploadedAt)}</td><td>${doc.fields.length ? (pending ? `<span class="status-badge pending"><span class="status-dot"></span>Review needed</span>` : `<span class="status-badge verified"><span class="status-dot"></span>Verified</span>`) : `<span class="status-badge neutral">No extraction</span>`}</td><td>${doc.calculation ? `${formatNumber(doc.calculation.result)} tCO₂e` : "—"}</td></tr>`;
  }).join("");
  const calcContent = recentCalculations.length
    ? recentCalculations.map((doc) => `<div class="calc-row"><div class="calc-row-label"><span class="file-icon">PDF</span><span>${escapeHtml(doc.fields.find((field) => field.id === "product")?.verifiedValue ?? doc.fields.find((field) => field.id === "product")?.value ?? "Calculation")}<small>${escapeHtml(doc.fileName)}</small></span></div><button class="calc-value calc-value-link" data-open-document="${escapeHtml(doc.id)}" data-action="open-provenance">${formatNumber(doc.calculation.result)} tCO₂e</button></div>`).join("")
    : `<div class="calc-empty"><strong>No calculations yet</strong><span>Verify the required inputs on a document to generate an auditable result.</span></div>`;

  content.innerHTML = `
    ${pageHeading("Compliance workspace", "Workspace overview", "Review supplier evidence and keep every CBAM number connected to its source.", uploadButton)}
    <div class="metric-grid">
      ${metricCard("Documents processed", stats.documents, "In this local workspace", "document")}
      ${metricCard("Pending verification", stats.pending, "Human review required", "clock")}
      ${metricCard("Verified calculations", stats.calculations, "Deterministic rule execution", "calculator")}
      ${metricCard("Exceptions", stats.exceptions, "Items requiring attention", "alert")}
      ${metricCard("Audit readiness", stats.auditReady, "Verified records with provenance", "check")}
    </div>
    <div class="notice-strip"><span class="notice-mark">${uiIcon("info")}</span><span><strong>Illustrative sample only.</strong> This workspace demonstrates evidence traceability; it is not an official CBAM filing. Verify against current official CBAM guidance before compliance use.</span></div>
    <div class="dashboard-grid">
      <section class="panel"><div class="panel-header"><div><h2>Verification queue</h2><p>Documents with fields awaiting human review</p></div><button class="text-link" data-page="verification">Open queue →</button></div>
        ${recentDocuments.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Document</th><th>Uploaded</th><th>Status</th><th>Result</th></tr></thead><tbody>${documentRows}</tbody></table></div>` : `<div class="empty-state"><div class="empty-icon">${uiIcon("document")}</div><h3>Your evidence workspace is ready</h3><p>Upload a supplier PDF, or load the bundled illustrative invoice to try the complete audit flow.</p><div class="empty-actions"><button class="primary-button" data-action="load-demo">Load demo invoice</button><button class="secondary-button" data-action="trigger-upload">Upload a PDF</button></div></div>`}
      </section>
      <section class="panel"><div class="panel-header"><div><h2>Recent activity</h2><p>Recorded actions in this workspace</p></div><button class="text-link" data-page="audit">Audit trail →</button></div><div class="activity-summary">${state.events.length ? [...state.events].slice(-6).reverse().map((item) => `<div class="activity-row"><span class="activity-mark"></span><div><strong>${escapeHtml(item.description)}</strong><small>${formatTime(item.at)} · ${escapeHtml(item.documentReference ?? "Workspace")}</small></div></div>`).join("") : `<div class="calc-empty"><strong>No activity yet</strong><span>Upload a document or load the illustrative invoice to begin.</span></div>`}</div></section>
    </div>`;
}

function renderVerification() {
  const pendingDocs = state.documents.map((doc) => ({
    doc,
    fields: doc.fields.filter((field) => field.status === "pending"),
  })).filter((item) => item.fields.length);
  const rows = pendingDocs.flatMap(({ doc, fields }) => fields.map((field) => `<tr><td>${escapeHtml(doc.fields.find((item) => item.id === "supplier_name")?.value ?? "—")}</td><td>${escapeHtml(doc.fileName)}</td><td>${escapeHtml(field.label)} <small class="table-subtext">${escapeHtml(field.value)} ${escapeHtml(field.unit)}</small></td><td>${statusBadge("pending")}</td><td>${formatDate(doc.uploadedAt)}</td><td><button class="quiet-button" data-review-field="${escapeHtml(doc.id)}" data-field-id="${escapeHtml(field.id)}">Review →</button></td></tr>`)).join("");
  content.innerHTML = `${pageHeading("Human review", "Verification queue", "Review every proposed value against its source document before calculation.", `<button class="secondary-button" data-page="documents">Browse documents</button>`)}
    <section class="panel"><div class="panel-header"><div><h2>Fields pending review</h2><p>${rows ? pendingDocs.reduce((sum, item) => sum + item.fields.length, 0) : 0} field(s) require confirmation</p></div></div>
      ${rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Supplier</th><th>Document</th><th>Field</th><th>Status</th><th>Uploaded</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><div class="empty-icon">${uiIcon("check")}</div><h3>Verification queue is clear</h3><p>New extracted and manually entered values appear here as pending review.</p><div class="empty-actions"><button class="primary-button" data-action="load-demo">Load illustrative sample</button></div></div>`}
    </section>`;
}

function renderCalculations() {
  const docs = state.documents.filter((doc) => doc.calculation);
  const rows = docs.map((doc) => `<tr><td>${escapeHtml(doc.fileName)}</td><td>${formatNumber(doc.calculation.netMass)} t</td><td>${formatNumber(doc.calculation.emissionFactor)} tCO₂e/t</td><td><button class="text-link" data-open-document="${escapeHtml(doc.id)}" data-action="open-provenance">${formatNumber(doc.calculation.result)} tCO₂e</button></td><td>${escapeHtml(doc.calculation.rule.version)}</td></tr>`).join("");
  content.innerHTML = `${pageHeading("Deterministic outputs", "Calculations", "Results are generated only from human-verified inputs and a versioned rule.")}
    <section class="panel"><div class="panel-header"><div><h2>Verified calculations</h2><p>${docs.length} calculation(s) available</p></div></div>
      ${rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Source document</th><th>Net mass</th><th>Emission factor</th><th>Result</th><th>Rule version</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><div class="empty-icon">${uiIcon("calculator")}</div><h3>No calculations generated</h3><p>Verify net mass and emission factor in a document to unlock calculation.</p><div class="empty-actions"><button class="primary-button" data-action="load-demo">Load illustrative sample</button></div></div>`}
    </section>`;
}

function renderRules() {
  content.innerHTML = `${pageHeading("Calculation governance", "Rules", "Versioned deterministic logic used by the current workspace.")}
    <section class="panel"><div class="panel-header"><div><h2>Available rules</h2><p>Only the explicitly demonstrated iron and steel workflow is enabled.</p></div><span class="status-badge verified"><span class="status-dot"></span>Active</span></div>
      <div class="rules-detail"><div><span>Rule ID</span><strong>EMBEDDED_EMISSIONS</strong></div><div><span>Version</span><strong>v2026.1</strong></div><div><span>Sector</span><strong>Iron and steel</strong></div><div><span>Effective date</span><strong>2026-01-01</strong></div><div><span>Required inputs</span><strong>Verified net mass · verified emission factor</strong></div><div><span>Formula</span><strong class="rule-formula">embedded_emissions = net_mass × emission_factor</strong></div></div>
      <div class="upload-warning">This is a sample calculation rule, not a statement of current CBAM legal requirements. Verify against current official CBAM guidance before compliance use.</div>
    </section>`;
}

function renderReports() {
  const docs = [...state.documents].reverse();
  const rows = docs.map((doc) => `<tr><td>${escapeHtml(doc.fileName)}</td><td>${escapeHtml(doc.fields.find((field) => field.id === "supplier_name")?.verifiedValue ?? doc.fields.find((field) => field.id === "supplier_name")?.value ?? "—")}</td><td>${doc.calculation ? `<button class="calc-value calc-value-link" data-open-document="${escapeHtml(doc.id)}" data-action="open-provenance">${formatNumber(doc.calculation.result)} tCO₂e</button>` : "No calculation"}</td><td>${doc.calculation ? `<span class="status-badge state-verified">Verified</span>` : `<span class="status-badge state-unverified">Inputs incomplete</span>`}</td><td><button class="quiet-button" data-action="export-report-for" data-document-id="${escapeHtml(doc.id)}">JSON</button>${doc.calculation ? `<button class="quiet-button" data-action="export-pdf-for" data-document-id="${escapeHtml(doc.id)}" ${pdfReportDocumentId === doc.id ? "disabled" : ""}>${pdfReportDocumentId === doc.id ? "Generating PDF…" : "PDF"}</button>` : ""}</td></tr>`).join("");
  content.innerHTML = `${pageHeading("Audit deliverables", "Reports", "Export a traceable report for a source document.", `<button class="secondary-button" data-page="audit">View audit trail</button>`)}
    <section class="panel"><div class="panel-header"><div><h2>Report records</h2><p>JSON includes field-level provenance and audit events; PDF summarizes the verified calculation.</p></div></div>
      ${rows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Document</th><th>Supplier</th><th>Result</th><th>Status</th><th>Export</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><div class="empty-icon">${uiIcon("report")}</div><h3>No reportable records</h3><p>Load a sample document and verify its inputs to prepare a report.</p><div class="empty-actions"><button class="primary-button" data-action="load-demo">Load illustrative sample</button></div></div>`}
    </section>`;
}

async function loadSecurityStatus() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    backendSecurity = (await response.json()).security;
  } catch {
    backendSecurity = null;
  }
  if (state.page === "settings") renderSettings();
}

async function reconcileServerVerifications() {
  let changed = false;
  for (const doc of state.documents) {
    const locallyVerified = doc.fields.filter((field) => field.status === "verified");
    if (!locallyVerified.length) continue;
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(doc.id)}/verified-fields`);
      if (!response.ok) throw new Error(`Verification lookup returned ${response.status}.`);
      const { fields: serverFields } = await response.json();
      const verifiedById = new Map(serverFields.map((field) => [field.field_id, field]));
      for (const field of locallyVerified) {
        const serverField = verifiedById.get(field.id);
        const isMatch = serverField
          && serverField.value === String(field.verifiedValue)
          && serverField.unit === field.unit
          && serverField.source_page === (field.page ?? 1);
        if (isMatch) {
          field.verifiedAt = serverField.verified_at;
          field.verifiedBy = serverField.verified_by;
          continue;
        }
        field.status = "pending";
        field.verifiedValue = null;
        field.verifiedAt = null;
        field.verifiedBy = null;
        changed = true;
      }
      if (doc.calculation && !isCalculationCurrent(doc)) {
        doc.calculation = null;
        changed = true;
      }
    } catch (error) {
      console.error(`Could not reconcile server verification for ${doc.fileName}.`, error);
      toast(`Could not confirm saved reviews for ${doc.fileName}. Calculation stays protected until the API is available.`);
    }
  }
  if (changed) {
    persist();
    render();
  }
}

function renderSettings() {
  const controls = backendSecurity
    ? [
        ["PDF file validation", backendSecurity.file_validation, "MIME, file signature, size, and filename checks"],
        ["Server-side payload validation", backendSecurity.server_side_validation, "Typed, bounded Pydantic request models"],
        ["No secrets in frontend", backendSecurity.secrets_in_frontend === false, "No provider keys are included in browser code"],
        ["Audit logging", backendSecurity.audit_logging, "SQLite audit records; updates/deletes are blocked"],
        ["External provider not configured", backendSecurity.external_provider_configured === false, "No external OCR or extraction API key is required"],
      ]
    : [];
  content.innerHTML = `${pageHeading("Workspace controls", "Settings & security", "Implemented controls for this local demonstration; no enterprise certification is claimed.")}
    <section class="panel"><div class="panel-header"><div><h2>Security status</h2><p>${backendSecurity ? "Live status from the local API" : "API unavailable — start the FastAPI server to inspect live controls"}</p></div><span class="status-badge ${backendSecurity ? "verified" : "pending"}"><span class="status-dot"></span>${backendSecurity ? "API connected" : "API unavailable"}</span></div>
      <div class="security-list">${controls.map(([label, enabled, detail]) => `<div class="security-row"><span class="security-check ${enabled ? "ok" : "off"}">${enabled ? "✓" : "!"}</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div><span class="status-badge ${enabled ? "verified" : "neutral"}">${enabled ? "Enabled" : "Unavailable"}</span></div>`).join("")}</div>
      <div class="upload-warning">Files are stored locally under generated UUID names. The API key boundary is currently inactive because no external provider is configured.</div>
    </section>`;
}

function renderTesting() {
  content.innerHTML = `${pageHeading("Quality assurance", "Testing", "Run the automated suites locally. Results are not inferred or displayed as passed unless the command has actually completed.")}
    <section class="panel"><div class="panel-header"><div><h2>Test suites</h2><p>Coverage maintained in the repository</p></div><span class="status-badge neutral">Run locally</span></div>
      <div class="testing-list"><div>Calculation, verification, provenance, and scenario domain tests <code>tests/domain.test.js</code></div><div>PDF fixture validity <code>tests/pdf.test.js</code></div><div>Extraction fallback boundary <code>tests/extraction.test.js</code></div><div>API validation, upload security, audit immutability, and PDF report <code>tests/test_backend.py</code></div></div>
      <pre class="command-block">npm test
npm run test:backend</pre>
    </section>`;
}

function renderDocumentsList() {
  const docs = [...state.documents].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  const rows = docs.map((doc) => `<tr data-open-document="${escapeHtml(doc.id)}"><td><div class="file-cell"><span class="file-icon">PDF</span><span>${escapeHtml(doc.fileName)}<small>${escapeHtml(doc.documentType)}</small></span></div></td><td>${formatDate(doc.uploadedAt)}</td><td>${escapeHtml(doc.processingStatus)}</td><td>${doc.calculation ? `${formatNumber(doc.calculation.result)} tCO₂e` : "—"}</td><td><button class="quiet-button" data-open-document="${escapeHtml(doc.id)}">Open →</button></td></tr>`).join("");
  content.innerHTML = `
    ${pageHeading("Evidence library", "Documents", "Supplier source records, extraction proposals, and verified fields.", `<button class="primary-button" data-action="trigger-upload"><span class="button-icon">${uiIcon("plus")}</span> Upload document</button>`)}
    <div class="upload-drop"><div class="upload-drop-icon">${uiIcon("upload")}</div><div class="upload-copy"><strong>Upload a supplier PDF</strong><span>PDF, up to 15 MB. The file stays in this browser session.</span></div><button class="secondary-button" data-action="trigger-upload">Choose PDF</button></div>
    <section class="panel"><div class="panel-header"><div><h2>All documents</h2><p>${docs.length} document${docs.length === 1 ? "" : "s"} in this workspace</p></div><button class="text-link" data-action="load-demo">Load illustrative sample</button></div>
      ${docs.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Document</th><th>Uploaded</th><th>Processing</th><th>Calculation</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><div class="empty-icon">${uiIcon("document")}</div><h3>No documents yet</h3><p>Load the bundled sample for a fast end-to-end demo, or upload your own PDF.</p><div class="empty-actions"><button class="primary-button" data-action="load-demo">Load demo invoice</button></div></div>`}
    </section>
    <div class="upload-warning"><strong>Extraction boundary:</strong> the local demo fallback proposes fields only for the bundled illustrative invoice. Uploaded PDFs are previewed locally; this offline MVP does not claim OCR or AI extraction for arbitrary files. Add source fields manually or use the sample to demonstrate the verification and audit workflow.</div>`;
}

function renderFieldCard(field) {
  const isEditing = editingFieldId === field.id;
  const selected = focusedFieldId === field.id;
  const currentValue = field.status === "verified" ? field.verifiedValue : field.value;
  const visualState = field.status === "verified" ? "verified"
    : field.status === "rejected" ? "rejected"
      : field.status === "pending" && String(currentValue ?? "").trim() ? "pending" : "unverified";
  const editControl = isEditing
    ? `<div class="edit-wrap"><input class="edit-input" id="edit-${escapeHtml(field.id)}" value="${escapeHtml(currentValue)}" aria-label="Edit ${escapeHtml(field.label)}"><button class="primary-button" data-action="save-field" data-field-id="${escapeHtml(field.id)}">Save & confirm</button></div>`
    : `<div class="field-value-row"><strong class="field-value">${escapeHtml(currentValue || "No value entered")}</strong><span class="field-unit">${escapeHtml(field.unit)}</span></div>`;
  const actions = field.status === "verified"
    ? `<div class="field-actions"><button class="quiet-button" data-action="edit-field" data-field-id="${escapeHtml(field.id)}">Edit value</button><button class="quiet-button" data-action="reopen-field" data-field-id="${escapeHtml(field.id)}">Re-review</button></div>`
    : field.status === "rejected"
      ? `<div class="field-actions"><button class="quiet-button" data-action="edit-field" data-field-id="${escapeHtml(field.id)}">Edit and review</button></div>`
      : `<div class="field-actions"><button class="quiet-button" data-action="edit-field" data-field-id="${escapeHtml(field.id)}">Edit</button><button class="danger-button" data-action="reject-field" data-field-id="${escapeHtml(field.id)}">Reject</button><button class="primary-button" data-action="confirm-field" data-field-id="${escapeHtml(field.id)}">Confirm</button></div>`;
  return `<article class="field-card state-${visualState} ${selected ? "selected" : ""}" data-field-card="${escapeHtml(field.id)}" tabindex="0" role="group" aria-label="${escapeHtml(field.label)} — ${escapeHtml(visualState)}">
    <div class="field-title-row"><span class="field-title">${escapeHtml(field.label)}</span>${statusBadge(visualState)}</div>
    ${editControl}
    <div class="field-meta"><span>${field.confidence == null ? "Manual entry" : `${escapeHtml(field.confidence)}% confidence`}</span><span>Page ${escapeHtml(field.page ?? "—")}</span></div>
    ${field.status === "verified" ? `<div class="verified-value"><svg class="verified-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.2 3 3 6-6.4"/></svg>Verified by ${escapeHtml(field.verifiedBy ?? "Demo auditor")} · ${formatTime(field.verifiedAt)}</div>` : ""}
    ${field.status === "rejected" ? `<div class="verified-value">Rejected by ${escapeHtml(field.verifiedBy ?? "Demo auditor")}</div>` : ""}
    ${actions}
  </article>`;
}

function sampleDocumentMarkup(doc) {
  const field = (id) => doc.fields.find((item) => item.id === id);
  const isFocused = (id) => focusedFieldId === id ? "invoice-highlight" : "";
  return `<div class="pdf-placeholder">
    <div class="invoice-top"><div class="invoice-brand">DEMO STEEL SUPPLIER<small>ILLUSTRATIVE SOURCE DOCUMENT</small></div><div class="invoice-mark">DS</div></div>
    <div class="invoice-title">Supplier invoice</div><div class="invoice-kicker">INVOICE NO. DEMO-2026-014 &nbsp; · &nbsp; 14 FEBRUARY 2026</div>
    <div class="invoice-meta"><div><span>Supplier / Origin</span><strong class="${isFocused("supplier_name")}">${escapeHtml(field("supplier_name")?.value)}</strong><br><strong class="${isFocused("country")}">${escapeHtml(field("country")?.value)}</strong></div><div><span>Product</span><strong class="${isFocused("product")}">${escapeHtml(field("product")?.value)}</strong></div></div>
    <div class="invoice-line"></div>
    <table class="invoice-table"><thead><tr><th>Product / tariff reference</th><th>Net mass</th><th>Specific emissions</th></tr></thead><tbody><tr><td><strong class="${isFocused("CN_code")}">${escapeHtml(field("CN_code")?.value)}</strong><br>Hot rolled steel coil</td><td><strong class="${isFocused("net_mass")}">${escapeHtml(field("net_mass")?.value)} ${escapeHtml(field("net_mass")?.unit)}</strong></td><td><strong class="${isFocused("emissions_value")}">${escapeHtml(field("emissions_value")?.value)} ${escapeHtml(field("emissions_value")?.unit)}</strong></td></tr></tbody></table>
    <div class="invoice-line"></div><div class="invoice-foot">This document and all values shown are illustrative demonstration data only. They do not represent an official supplier record or verified regulatory declaration.</div>
    <p class="source-note">SOURCE PAGE 1 · Select an extracted field to highlight its source value</p>
  </div>`;
}

function manualFieldForm(doc) {
  const available = FIELD_DEFINITIONS.filter((definition) => !doc.fields.some((field) => field.id === definition.id));
  if (!available.length) return "";
  return `<form id="manual-field-form" class="panel" style="padding:14px;margin:12px 13px">
    <strong style="font-size:11px;color:#4c626d">Add a source field manually</strong>
    <div class="edit-wrap" style="margin-top:10px;flex-wrap:wrap">
      <select class="edit-input" name="fieldId" aria-label="Field name" required style="flex:1;min-width:130px">${available.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("")}</select>
      <input class="edit-input" name="value" aria-label="Source value" placeholder="Enter source value" required style="flex:1;min-width:130px">
      <input class="edit-input" name="page" type="number" min="1" value="1" aria-label="Source page" style="width:75px">
      <button class="primary-button" type="submit">Add field</button>
    </div><small style="color:#9aa6aa;font-size:9px">Manual values still require human confirmation before calculation.</small>
  </form>`;
}

function renderExceptions(document) {
  const exceptions = getExceptions(document);
  if (!exceptions.length) return `<div class="no-exceptions">${uiIcon("check")}No input issues detected for the current calculation.</div>`;
  return exceptions.map((exception) => `<div class="exception-item"><span class="exception-icon">${uiIcon("alert")}</span><span>${escapeHtml(exception)}</span></div>`).join("");
}

function renderDocumentWorkspace(doc) {
  const selectedField = doc.fields.find((field) => field.id === focusedFieldId);
  const pdfData = doc.isDemo
    ? (samplePdfDataUrl ??= createSamplePdfDataUrl())
    : doc.serverStored
      ? `/api/documents/${encodeURIComponent(doc.id)}/file`
      : (uploadDataByDocId.get(doc.id) ?? null);
  const sourcePanel = selectedField
    ? `<div class="source-focus"><strong>Selected source:</strong> Page ${escapeHtml(selectedField.page ?? "—")} · <code>${escapeHtml(selectedField.sourceText ?? "Manually added field")}</code><br>${selectedField.coordinates ? `<span class="source-coordinates">Coordinates: x=${selectedField.coordinates.x}, y=${selectedField.coordinates.y}</span> · ` : ""}Proposed: ${escapeHtml(selectedField.value)} ${escapeHtml(selectedField.unit)}</div>`
    : "";
  const fieldsMarkup = doc.fields.length
    ? doc.fields.map(renderFieldCard).join("")
    : `<div class="empty-state"><div class="empty-icon">${uiIcon("search")}</div><h3>No extraction available for this upload</h3><p>The offline fallback only extracts the bundled sample. Add source fields manually below; each still requires human verification.</p></div>${manualFieldForm(doc)}`;
  const mass = doc.fields.find((field) => field.id === "net_mass");
  const factor = doc.fields.find((field) => field.id === "emissions_value");
  const missingRequired = [
    !mass || mass.status !== "verified" ? "Net mass" : null,
    !factor || factor.status !== "verified" ? "Emission factor" : null,
  ].filter(Boolean);
  const canScenario = mass?.status === "verified";
  const initialFactor = factor?.verifiedValue ?? factor?.value ?? "1.9";
  let scenarioValue = "Verify net mass first";
  if (canScenario) {
    try {
      scenarioValue = `${formatNumber(calculateScenario(doc, initialFactor).result)} tCO₂e`;
    } catch {
      scenarioValue = "Enter a valid factor";
    }
  }
  const resultMarkup = doc.calculation
    ? `<section class="verified-result"><div class="verified-result-head"><span class="result-eyebrow">Verified result</span><span class="rule-reference">${escapeHtml(doc.calculation.rule.ruleId)} · ${escapeHtml(doc.calculation.rule.version)}</span></div><div class="result-line"><button class="result-number" data-action="toggle-trace" aria-expanded="${inlineTraceOpen}" aria-controls="inline-provenance">${formatNumber(doc.calculation.result)}<span class="result-unit">tCO₂e</span></button><button class="recalculate-link" data-action="calculate">Recalculate</button></div><div class="result-rule">Select the result to inspect its complete evidence chain.</div></section>
      <section class="provenance-inline ${inlineTraceOpen ? "is-open" : ""}" id="inline-provenance" aria-label="Calculation provenance" aria-hidden="${!inlineTraceOpen}" ${inlineTraceOpen ? "" : "inert"}>
        <div class="trace-heading"><span>Calculation provenance</span><button class="trace-close" data-action="toggle-trace">Close</button></div>
        <div class="trace-chain" aria-label="Source, verified input, rule version, formula, result">
          <button class="trace-node" data-action="trace-source" data-field-id="emissions_value"><span class="trace-index">01</span><span class="trace-label">Source</span><strong>${escapeHtml(doc.fileName)}</strong><small>${escapeHtml(factor?.id ?? "—")} · Page ${escapeHtml(factor?.page ?? "—")}${factor?.coordinates ? ` · <span class="trace-coordinate">x=${factor.coordinates.x}, y=${factor.coordinates.y}</span>` : ""}</small></button>
          <span class="trace-arrow" aria-hidden="true">→</span>
          <button class="trace-node" data-action="trace-input" data-field-id="emissions_value"><span class="trace-index">02</span><span class="trace-label">Verified input</span><strong>${escapeHtml(factor?.verifiedValue ?? "—")} ${escapeHtml(factor?.unit ?? "")}</strong><small>Human-verified · ${escapeHtml(factor?.verifiedBy ?? "—")} · Page ${escapeHtml(factor?.page ?? "—")}</small></button>
          <span class="trace-arrow" aria-hidden="true">→</span>
          <button class="trace-node" data-action="trace-rule"><span class="trace-index">03</span><span class="trace-label">Rule version</span><strong>${escapeHtml(doc.calculation.rule.ruleId)}</strong><small>${escapeHtml(doc.calculation.rule.version)} · ${escapeHtml(doc.calculation.rule.sector)}</small></button>
          <span class="trace-arrow" aria-hidden="true">→</span>
          <button class="trace-node" data-action="trace-formula" data-field-id="net_mass"><span class="trace-index">04</span><span class="trace-label">Formula</span><strong>${escapeHtml(doc.calculation.formula)}</strong><small>${formatNumber(doc.calculation.netMass)} t × ${formatNumber(doc.calculation.emissionFactor)} tCO₂e/t</small></button>
          <span class="trace-arrow" aria-hidden="true">→</span>
          <div class="trace-node trace-final"><span class="trace-index">05</span><span class="trace-label">Result</span><strong>${formatNumber(doc.calculation.result)} tCO₂e</strong><small>${formatDate(doc.calculation.executedAt, { hour: "2-digit", minute: "2-digit" })}</small></div>
        </div>
      </section>`
    : `<section class="calculation-lock ${missingRequired.length ? "is-locked" : "is-ready"}"><div class="calculation-lock-title"><span class="result-eyebrow">Verified result</span><strong>${missingRequired.length ? "Calculation locked" : "Ready to calculate"}</strong></div><button class="primary-button calculate-button" data-action="calculate" ${missingRequired.length ? "disabled" : ""}>Calculate</button><p class="lock-reason" role="status">${missingRequired.length ? `Verify ${missingRequired.join(" and ")} to calculate.` : "Required fields confirmed. Calculate to create a verified result."}</p></section>`;
  const preview = doc.isDemo
    ? `<div class="pdf-viewer">${sampleDocumentMarkup(doc)}</div>`
    : pdfData
      ? `<div class="pdf-viewer"><iframe title="Uploaded source PDF" src="${pdfData}"></iframe></div>`
      : `<div class="pdf-viewer"><div class="empty-state" style="align-self:center"><div class="empty-icon">${uiIcon("report")}</div><h3>PDF is not available after reload</h3><p>Uploaded file previews stay in browser memory. Re-upload the source file to preview it again; verified metadata and audit events are retained.</p><button class="secondary-button" data-action="trigger-upload">Re-upload PDF</button></div></div>`;
  content.innerHTML = `
    ${pageHeading("Source review", escapeHtml(doc.fileName), `${escapeHtml(doc.documentType)} · Uploaded ${formatDate(doc.uploadedAt, { hour: "2-digit", minute: "2-digit" })}`, `<div class="quick-actions"><button class="secondary-button" data-page="documents">← Documents</button>${doc.isDemo ? `<button class="secondary-button" data-action="download-sample">Download sample PDF</button>` : ""}</div>`)}
    <div class="document-layout review-workspace">
      <section class="source-panel document-panel"><div class="document-panel-head"><div class="document-panel-title"><span class="file-icon">PDF</span><span><strong>${escapeHtml(doc.fileName)}</strong><small>${escapeHtml(doc.processingStatus)}</small></span></div><span class="page-tag">${doc.isDemo ? "PAGE 1" : selectedField ? `SOURCE PAGE ${escapeHtml(selectedField.page ?? "—")}` : "PDF PREVIEW"}</span></div>${preview}${sourcePanel ? `<div class="source-reference">${sourcePanel}</div>` : ""}</section>
      <section class="evidence-panel field-panel">
        <div class="field-panel-head"><div><h2>Structured evidence</h2><p>Compare each value with its source before confirming.</p></div><span class="verified-count">${doc.fields.filter((field) => field.status === "verified").length}/${doc.fields.length} VERIFIED</span></div>
        <p class="review-note">Extracted values require human verification before use in a calculation.</p>
        <div class="field-list">${fieldsMarkup}</div>
        ${manualFieldForm(doc)}
        ${resultMarkup}
        <section class="scenario-panel scenario-workspace"><div class="scenario-header"><div><span class="scenario-kicker">Separate analysis</span><h2>Scenario — not verified</h2></div><span class="scenario-mark" aria-hidden="true">${uiIcon("arrowUpRight")}</span></div><div class="scenario-body"><div class="scenario-top"><label for="scenario-factor">Emission factor <span>(tCO₂e/t)</span></label><input class="scenario-input" id="scenario-factor" type="number" min="0.000001" step="0.1" value="${escapeHtml(initialFactor)}" ${!canScenario ? "disabled" : ""}></div><div class="scenario-result"><span>Scenario result</span><strong id="scenario-result">${escapeHtml(scenarioValue)}</strong></div><p class="scenario-warning">Scenario only — does not modify verified records.</p></div></section>
        <section class="exception-panel"><div class="exception-heading"><strong>Exceptions</strong><span class="exception-count">${getExceptions(doc).length} to review</span></div><div class="exception-body">${renderExceptions(doc)}</div></section>
      </section>
    </div>`;
}

function renderAudit() {
  const events = [...state.events].sort((a, b) => a.at.localeCompare(b.at));
  const doc = currentDocument();
  const action = doc ? `<button class="primary-button" data-action="export-report">↓ Export audit report</button>` : "";
  const eventRows = events.map((event) => `<div class="audit-item"><div class="audit-time">${formatTime(event.at)}<br>${formatDate(event.at, { year: undefined })}</div><div class="audit-marker"></div><div class="audit-content"><strong>${escapeHtml(event.description)}<span class="audit-tag">${escapeHtml(event.type.replace(/_/g, " "))}</span></strong><small>${escapeHtml(event.user)}${event.related ? ` · ${escapeHtml(event.related)}` : ""}${event.documentReference ? ` · ${escapeHtml(event.documentReference)}` : ""}</small></div></div>`).join("");
  content.innerHTML = `${pageHeading("Evidence history", "Audit trail", "A chronological, locally stored record of document processing and user actions.", action)}
    <div class="report-banner"><div><strong>Append-only activity history</strong><br><span>Actions are timestamped and linked to their document reference.</span></div><span>${events.length} event${events.length === 1 ? "" : "s"}</span></div>
    <section class="panel"><div class="panel-header"><div><h2>Activity timeline</h2><p>Most recent activity appears last</p></div></div>${events.length ? `<div class="audit-list">${eventRows}</div>` : `<div class="audit-empty">No events yet. Load the demo invoice or upload a document to begin the audit trail.</div>`}</section>
    <div class="upload-warning">Audit events are stored in this browser's local storage and are intended for demonstration only. The exported report includes field-level source references and the calculation rule where available.</div>`;
}

function render() {
  const doc = currentDocument();
  document.querySelectorAll(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.page === (doc && state.page === "documents" ? "documents" : state.page)));
  document.querySelector("#document-nav-count").textContent = state.documents.length;
  const title = doc && state.page === "documents" ? "Document review" : ({
    dashboard: "Overview",
    documents: "Documents",
    verification: "Verification",
    calculations: "Calculations",
    audit: "Audit trail",
    rules: "Rules",
    reports: "Reports",
    settings: "Settings & security",
    testing: "Testing",
  }[state.page] ?? "Overview");
  document.querySelector("#breadcrumb-current").textContent = title;
  if (state.page === "dashboard") renderDashboard();
  else if (state.page === "documents" && doc) renderDocumentWorkspace(doc);
  else if (state.page === "documents") renderDocumentsList();
  else if (state.page === "verification") renderVerification();
  else if (state.page === "calculations") renderCalculations();
  else if (state.page === "audit") renderAudit();
  else if (state.page === "rules") renderRules();
  else if (state.page === "reports") renderReports();
  else if (state.page === "settings") renderSettings();
  else if (state.page === "testing") renderTesting();
  else renderDashboard();
}

function openDocument(documentId) {
  if (!state.documents.some((doc) => doc.id === documentId)) return;
  state.activeDocId = documentId;
  state.page = "documents";
  editingFieldId = null;
  focusedFieldId = null;
  render();
}

async function loadDemo() {
  const existing = state.documents.find((doc) => doc.isDemo);
  if (existing) {
    openDocument(existing.id);
    toast("Loaded the illustrative invoice.");
    return;
  }
  try {
    const extraction = await extractDocument({ mode: "demo_fixture" });
    const doc = extraction.document;
    state.documents.push(doc);
    state.activeDocId = doc.id;
    state.page = "documents";
    focusedFieldId = "emissions_value";
    addEvent("document_uploaded", "Uploaded illustrative supplier invoice", doc.id, "demo_supplier_invoice.pdf");
    addEvent("extraction_completed", "Demo fallback proposed 6 fields; human verification required", doc.id, "6 proposals");
    persist();
    render();
    toast("Demo invoice loaded. Review and confirm the proposed fields.");
  } catch (error) {
    toast(`Demo extraction failed: ${error.message}`, true);
  }
}

function updateCalculationAfterInputChange(doc) {
  if (doc.calculation && !isCalculationCurrent(doc)) {
    doc.calculation = null;
    addEvent("calculation_invalidated", "Calculation cleared because a required input changed", doc.id, "Re-verify and recalculate");
  }
}

async function verifyField(fieldId, valueOverride = undefined) {
  const doc = currentDocument();
  const field = doc?.fields.find((candidate) => candidate.id === fieldId);
  if (!field) return;
  const value = valueOverride ?? field.value;
  if (value == null || !String(value).trim()) {
    toast("Enter a value before confirming this field.", true);
    return;
  }
  try {
    const response = await fetch("/api/fields/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document_id: doc.id,
        field_id: field.id,
        value: String(value).trim(),
        unit: field.unit,
        source_page: field.page ?? 1,
        actor: "Demo auditor",
      }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.detail ?? `Verification service returned ${response.status}.`);
    field.value = String(value).trim();
    field.verifiedValue = String(value).trim();
    field.status = "verified";
    field.verifiedAt = result.verified_at;
    field.verifiedBy = "Demo auditor";
    updateCalculationAfterInputChange(doc);
    addEvent("field_verified", `Human-verified ${field.label}`, doc.id, `${field.label}: ${field.verifiedValue}${field.unit ? ` ${field.unit}` : ""}`, false, result.audit_event_id);
    persist();
    editingFieldId = null;
    focusedFieldId = fieldId;
    render();
    toast(`${field.label} verified by human review.`);
  } catch (error) {
    toast(`Verification was not saved: ${error.message}`, true);
  }
}

async function revokeFieldVerification(doc, field, action) {
  const response = await fetch("/api/fields/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_id: doc.id,
      field_id: field.id,
      action,
      actor: "Demo auditor",
      detail: `${action === "reopened" ? "Returned" : "Rejected"} ${field.label}`,
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.detail ?? `Review service returned ${response.status}.`);
  return result.audit_event_id;
}

async function calculate() {
  const doc = currentDocument();
  if (!doc) return;
  try {
    const proposedCalculation = calculateEmbeddedEmissions(doc);
    const response = await fetch("/api/calculations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document_id: doc.id,
        net_mass: proposedCalculation.netMass,
        net_mass_unit: doc.fields.find((field) => field.id === "net_mass").unit,
        emission_factor: proposedCalculation.emissionFactor,
        emission_factor_unit: doc.fields.find((field) => field.id === "emissions_value").unit,
        net_mass_verified: true,
        emission_factor_verified: true,
        source_field_ids: proposedCalculation.inputFieldIds,
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.detail ?? `Calculation service returned ${response.status}.`);
    }
    const serverCalculation = await response.json();
    if (serverCalculation.result !== proposedCalculation.result) {
      throw new Error("The server calculation did not match the local deterministic result.");
    }
    doc.calculation = {
      ...proposedCalculation,
      id: serverCalculation.calculation_id,
      result: serverCalculation.result,
      executedAt: serverCalculation.created_at,
      rule: { ...proposedCalculation.rule, version: serverCalculation.rule_version },
    };
    addEvent("rule_executed", `Executed ${doc.calculation.rule.ruleId} ${doc.calculation.rule.version}`, doc.id, doc.calculation.formula);
    addEvent("calculation_generated", `Calculation generated: ${formatNumber(doc.calculation.result)} tCO₂e`, doc.id, doc.calculation.id, false, serverCalculation.audit_event_id);
    persist();
    render();
    toast("Deterministic calculation complete.");
  } catch (error) {
    toast(error.message, true);
  }
}

function downloadFile(name, contentText, mimeType) {
  const blob = new Blob([contentText], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportReport(doc = currentDocument()) {
  if (!doc) {
    toast("Open a document before exporting its audit report.", true);
    return;
  }
  addEvent("report_exported", "Audit report exported as JSON", doc.id, doc.fileName);
  persist();
  const report = buildAuditReport(doc, state.events);
  const baseName = doc.fileName.replace(/\.pdf$/i, "").replace(/[^a-z0-9_-]/gi, "_");
  downloadFile(`${baseName}_audit_report.json`, JSON.stringify(report, null, 2), "application/json");
  render();
  toast("Audit report downloaded.");
}

async function exportPdfReport(doc) {
  if (!doc?.calculation) {
    toast("Verify the required inputs before exporting a PDF report.", true);
    return;
  }
  const fieldValue = (id) => doc.fields.find((field) => field.id === id);
  pdfReportDocumentId = doc.id;
  render();
  try {
    const response = await fetch("/api/reports/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        document_id: doc.id,
        supplier: fieldValue("supplier_name")?.verifiedValue ?? fieldValue("supplier_name")?.value ?? "—",
        product: fieldValue("product")?.verifiedValue ?? fieldValue("product")?.value ?? "—",
        cn_code: fieldValue("CN_code")?.verifiedValue ?? fieldValue("CN_code")?.value ?? "—",
        file_name: doc.fileName,
        net_mass: doc.calculation.netMass,
        emission_factor: doc.calculation.emissionFactor,
        result: doc.calculation.result,
        formula: doc.calculation.formula,
        verified: true,
        source_page: fieldValue("emissions_value")?.page ?? 1,
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.detail ?? `Report service returned ${response.status}.`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${doc.fileName.replace(/\.pdf$/i, "")}_audit_report.pdf`;
    anchor.click();
    URL.revokeObjectURL(url);
    addEvent("report_exported", "Audit report exported as PDF", doc.id, doc.fileName);
    persist();
    render();
    toast("PDF audit report downloaded.");
  } catch (error) {
    toast(`Report export failed: ${error.message}`, true);
  } finally {
    pdfReportDocumentId = null;
    render();
  }
}

function openProvenance() {
  if (!currentDocument()?.calculation) return;
  state.page = "documents";
  inlineTraceOpen = true;
  render();
  document.querySelector("#inline-provenance")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function openSourceField(fieldId) {
  modalRoot.innerHTML = "";
  focusedFieldId = fieldId;
  state.page = "documents";
  render();
  document.querySelector(`[data-field-card="${CSS.escape(fieldId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function showSource(fieldId) {
  const doc = currentDocument();
  const field = doc?.fields.find((item) => item.id === fieldId);
  if (!doc || !field) return;
  modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><aside class="provenance-drawer" role="dialog" aria-modal="true" aria-labelledby="source-title" data-modal-content><div class="modal-head"><div><p class="eyebrow">Source evidence</p><h2 id="source-title">${escapeHtml(field.label)}</h2><p>${escapeHtml(doc.fileName)} · Page ${escapeHtml(field.page ?? "—")}</p></div><button class="close-button" data-action="close-modal">×</button></div><div class="provenance-body"><div class="source-modal-card"><strong>Exact source text</strong><br>${escapeHtml(field.sourceText ?? "Manually added from the source document")}<br><br><strong>Proposed value</strong><br>${escapeHtml(field.value)} ${escapeHtml(field.unit)}<br><br><strong>Confidence</strong><br>${field.confidence == null ? "Manual entry" : `${escapeHtml(field.confidence)}%`}<br><br><strong>Source location</strong><br>Page ${escapeHtml(field.page ?? "—")}${field.coordinates ? ` · x=${field.coordinates.x}, y=${field.coordinates.y}` : " · Coordinates not available"}</div></div><div class="modal-foot"><small>Extracted proposal · human review required</small><button class="primary-button" data-action="open-source-field" data-field-id="${escapeHtml(fieldId)}">Open in document</button></div></aside></div>`;
}

async function uploadPdf(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    toast("Please select a PDF file.", true);
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    toast("This PDF is larger than the 15 MB demo limit.", true);
    return;
  }
  try {
    const existing = state.page === "documents"
      ? state.documents.find((candidate) => candidate.id === state.activeDocId && !candidate.isDemo && candidate.fileName === file.name && !uploadDataByDocId.has(candidate.id))
      : null;
    if (existing) {
      const fileDataUrl = await fileToDataUrl(file);
      uploadDataByDocId.set(existing.id, fileDataUrl);
      addEvent("source_reuploaded", `Re-attached source preview for ${file.name}`, existing.id, `${(file.size / 1024).toFixed(0)} KB`);
      persist();
      render();
      toast("PDF preview restored for this document.");
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    const uploadResponse = await fetch("/api/documents", { method: "POST", body: formData });
    if (!uploadResponse.ok) {
      const error = await uploadResponse.json().catch(() => null);
      throw new Error(error?.detail ?? `Upload service returned ${uploadResponse.status}.`);
    }
    const upload = await uploadResponse.json();
    const extraction = await extractDocument({ mode: "uploaded_pdf", fileName: file.name });
    const doc = {
      id: upload.document_id,
      fileName: file.name,
      documentType: "Supplier document · PDF upload",
      uploadedAt: upload.uploaded_at,
      processingStatus: `Server stored · ${extraction.message}`,
      isDemo: false,
      serverStored: true,
      fields: [],
      calculation: null,
    };
    state.documents.push(doc);
    state.activeDocId = doc.id;
    state.page = "documents";
    focusedFieldId = null;
    addEvent("document_uploaded", `Uploaded ${file.name}`, doc.id, `${(file.size / 1024).toFixed(0)} KB`, false, upload.audit_event_id);
    addEvent("extraction_unavailable", "OCR/AI extraction is not configured; no fields were fabricated", doc.id, "Manual field entry available");
    persist();
    render();
    toast("PDF added to this session. No unsupported extraction was claimed.");
  } catch (error) {
    toast(error.message, true);
  }
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action], [data-page], [data-open-document], [data-field-card], [data-review-field]");
  if (!target) return;
  if (target.dataset.page) {
    state.page = target.dataset.page;
    if (state.page === "documents") state.activeDocId = null;
    if (state.page !== "documents") focusedFieldId = null;
    render();
    return;
  }
  if (target.dataset.reviewField) {
    state.activeDocId = target.dataset.reviewField;
    focusedFieldId = target.dataset.fieldId;
    state.page = "documents";
    render();
    document.querySelector(`[data-field-card="${CSS.escape(focusedFieldId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (target.dataset.openDocument && target.dataset.action === "open-provenance") {
    openDocument(target.dataset.openDocument);
    openProvenance();
    return;
  }
  if (target.dataset.openDocument) {
    openDocument(target.dataset.openDocument);
    return;
  }
  if (target.dataset.fieldCard && !event.target.closest("button, input, select, a")) {
    focusedFieldId = target.dataset.fieldCard;
    render();
    return;
  }
  const action = target.dataset.action;
  if (!action) return;
  const fieldId = target.dataset.fieldId;
  const doc = currentDocument();
  if (action === "trigger-upload") {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.addEventListener("change", () => uploadPdf(input.files?.[0]));
    input.click();
  } else if (action === "load-demo") loadDemo();
  else if (action === "confirm-field") verifyField(fieldId);
  else if (action === "edit-field") {
    editingFieldId = fieldId;
    focusedFieldId = fieldId;
    render();
    document.querySelector(`#edit-${CSS.escape(fieldId)}`)?.focus();
  } else if (action === "save-field") {
    const input = document.querySelector(`#edit-${CSS.escape(fieldId)}`);
    verifyField(fieldId, input?.value);
  } else if (action === "reopen-field") {
    const field = doc?.fields.find((item) => item.id === fieldId);
    if (field) {
      try {
        const eventId = await revokeFieldVerification(doc, field, "reopened");
        field.status = "pending";
        field.verifiedValue = null;
        field.verifiedAt = null;
        updateCalculationAfterInputChange(doc);
        addEvent("field_reopened", `Returned ${field.label} to pending review`, doc.id, field.label, false, eventId);
        persist();
        render();
        toast(`${field.label} requires a new review.`);
      } catch (error) {
        toast(`Could not reopen verification: ${error.message}`, true);
      }
    }
  } else if (action === "reject-field") {
    const field = doc?.fields.find((item) => item.id === fieldId);
    if (field) {
      try {
        const eventId = await revokeFieldVerification(doc, field, "rejected");
        field.status = "rejected";
        field.verifiedValue = null;
        field.verifiedAt = new Date().toISOString();
        field.verifiedBy = "Demo auditor";
        updateCalculationAfterInputChange(doc);
        addEvent("field_rejected", `Rejected proposed ${field.label}`, doc.id, field.value, false, eventId);
        persist();
        render();
        toast(`${field.label} rejected.`);
      } catch (error) {
        toast(`Could not reject the field: ${error.message}`, true);
      }
    }
  } else if (action === "calculate") calculate();
  else if (action === "open-provenance") openProvenance();
  else if (action === "toggle-trace") {
    inlineTraceOpen = !inlineTraceOpen;
    render();
    if (inlineTraceOpen) document.querySelector("#inline-provenance")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (action === "trace-source" || action === "trace-input" || action === "trace-formula") {
    focusedFieldId = fieldId;
    inlineTraceOpen = true;
    render();
    document.querySelector(`[data-field-card="${CSS.escape(fieldId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  } else if (action === "trace-rule") {
    inlineTraceOpen = false;
    state.page = "rules";
    render();
  }
  else if (action === "close-modal") {
    if (target === event.target || target.classList.contains("close-button")) modalRoot.innerHTML = "";
  } else if (action === "view-source") showSource(fieldId);
  else if (action === "open-source-field") openSourceField(fieldId);
  else if (action === "provenance-step") {
    const step = target.dataset.step;
    if (step === "1" || step === "2") openSourceField("emissions_value");
    else if (step === "3") openSourceField("net_mass");
    else if (step === "4") {
      modalRoot.innerHTML = "";
      state.page = "rules";
      render();
    } else if (step === "5") openSourceField("emissions_value");
    else if (step === "6") {
      modalRoot.innerHTML = "";
      render();
    }
  }
  else if (action === "export-report") exportReport();
  else if (action === "export-report-for") {
    const reportDocument = state.documents.find((item) => item.id === target.dataset.documentId);
    exportReport(reportDocument);
  } else if (action === "export-pdf-for") {
    const reportDocument = state.documents.find((item) => item.id === target.dataset.documentId);
    await exportPdfReport(reportDocument);
  }
  else if (action === "download-sample") {
    samplePdfDataUrl ??= createSamplePdfDataUrl();
    const anchor = document.createElement("a");
    anchor.href = samplePdfDataUrl;
    anchor.download = "demo_supplier_invoice.pdf";
    anchor.click();
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id !== "manual-field-form") return;
  event.preventDefault();
  const doc = currentDocument();
  const formData = new FormData(event.target);
  const definition = FIELD_DEFINITIONS.find((item) => item.id === formData.get("fieldId"));
  if (!doc || !definition) return;
  const value = String(formData.get("value") ?? "").trim();
  const page = Number(formData.get("page"));
  if (!value || !Number.isInteger(page) || page < 1) {
    toast("Enter a source value and a valid page number.", true);
    return;
  }
  doc.fields.push({
    ...definition,
    value,
    confidence: null,
    page,
    coordinates: null,
    sourceText: `Manually transcribed from ${doc.fileName}, page ${page}`,
    status: "pending",
    verifiedValue: null,
    verifiedAt: null,
    verifiedBy: null,
  });
  addEvent("manual_field_added", `Added manual source field: ${definition.label}`, doc.id, `${value} · page ${page}`);
  persist();
  render();
  loadSecurityStatus();
  reconcileServerVerifications();
  toast("Manual source field added. Confirm it after review.");
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "scenario-factor") return;
  const doc = currentDocument();
  const resultElement = document.querySelector("#scenario-result");
  try {
    if (!doc || !event.target.value) throw new Error("Enter a positive factor.");
    const result = calculateScenario(doc, event.target.value);
    resultElement.textContent = `${formatNumber(result.result)} tCO₂e`;
  } catch {
    resultElement.textContent = "Enter a valid factor";
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") modalRoot.innerHTML = "";
  if (event.key === "Enter" && event.target.classList.contains("edit-input") && event.target.id.startsWith("edit-")) {
    const fieldId = event.target.id.slice(5);
    verifyField(fieldId, event.target.value);
  }
});

window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) {
    toast("Workspace data changed in another tab. Reload to see the latest copy.");
  }
});

render();
