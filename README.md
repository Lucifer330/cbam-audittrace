# CBAM-AuditTrace

**Trace every CBAM number back to its source.**

An evidence-linked workflow for CBAM (EU Carbon Border Adjustment Mechanism) compliance — built so every calculated value can be traced back through *verified input → source document → rule version → formula*, not just produced as a black-box number.

> 🟠 **Illustrative demo — not an official CBAM filing.** This MVP implements one scoped sample calculation for iron & steel. Verify against official EU CBAM guidance before any real compliance use.

---

## The problem

CBAM compliance isn't hard because the math is hard. It's hard because the **evidence chain breaks**:

| | |
|---|---|
| 🗂️ **Scattered evidence** | Invoices, EPDs, and emissions statements live across email and folders — no single source of truth |
| ⌨️ **Manual re-entry** | Mass, CN codes, and emissions values get typed into spreadsheets by hand — every re-entry risks an error |
| ❓ **No provenance** | When an auditor asks *"where did this number come from?"* — there's often no defensible answer |

**Core insight:** CBAM compliance is a data-traceability problem as much as a calculation problem.

*(EU CBAM's definitive phase began 1 Jan 2026; first declarations for 2026 imports are due 30 Sep 2027.)*

---

## The solution

SUPPLIER DOCUMENT → AI EXTRACTION → HUMAN VERIFY → RULES ENGINE → TRACEABLE RESULT → AUDIT TRAIL


| Step | What happens |
|---|---|
| **1. Supplier document** | Invoice / EPD PDF is uploaded |
| **2. AI extraction** | Candidate fields are proposed, each tagged with their source location in the PDF |
| **3. Human verify** | Every proposed field starts as *pending* — a person confirms, edits, or rejects it before anything is calculated |
| **4. Rules engine** | A deterministic, versioned rules module computes the result. **AI never performs the calculation** |
| **5. Traceable result** | Click any calculated number to see: `Source → Verified Input → Rule Version → Formula → Result` |
| **6. Audit trail** | Export the full record as JSON / PDF for review |

> **LLM assists extraction. Humans verify the evidence. Deterministic rules compute the result.**

### Who this is for

- **Primary user:** EU importers / CBAM declarants preparing shipment declarations
- **Workflow partner:** Customs representatives who need a defensible, reviewable evidence chain

---

## Why this isn't "just an AI calculator"

| Manual / conventional workflow | CBAM-AuditTrace |
|---|---|
| Document → manual entry → spreadsheet | Document → AI-proposed fields → human verification |
| Output is just a number | Output is a path: source → rule version → formula |
| Rules buried in a sheet or in code | Rules versioned as data, separate from app logic |
| Hard to retrace after the fact | Every result is explicitly reproducible |

Some tools already cover parts of this (extraction, or calculation, or carbon accounting). **Our focus is the evidence-to-calculation chain itself** — making it explicit, reviewable, and reproducible, not just producing a final figure.

---

## Demo flow

1. Click **Load demo invoice** — a sample PDF is generated in-browser and its source page is shown with selectable evidence regions.
2. Select a field, inspect its page, source text, and coordinates, then **confirm / edit / reject** the proposal. Every proposal starts as *pending review*.
3. Confirm **Net mass** and **Emission factor** — the **Calculate** action stays locked until both required inputs are human-verified.
4. Calculate: `1,000 t × 1.9 = 1,900 tCO₂e`, then click the result to inspect the full `source → verified input → rule version → formula → result` chain.
5. Change the what-if factor to `1.6` — a separate scenario shows `1,600 tCO₂e` **without modifying the verified result**.
6. Export the document's audit report as JSON, or review the activity timeline.

The dashboard starts empty; all counts come from real workspace records, not fabricated metrics.

---

## Architecture

SUPPLIER PDF
│
▼
EXTRACTION LAYER pdfplumber-style parsing + proposal interface
│ (AI proposes fields only — never calculates)
▼
VERIFICATION LAYER human approve / edit / reject, per field
│
▼
RULES LAYER pure Python, versioned CBAM rule tables
│ (no ML, no network call, fully deterministic)
▼
PROVENANCE LAYER field → source coordinates → rule version → formula → result
│
▼
OUTPUT dashboard + audit PDF + JSON export


| File | Responsibility |
|---|---|
| `src/extraction.js` | Extraction-service boundary — proposes the deterministic demo sample, or explicitly reports when extraction isn't configured |
| `src/domain.js` | Versioned rule definitions, verification gate, validation, deterministic calculator, scenario calculator, report serialization. **No AI or network dependency.** |
| `src/pdf.js` | Generates the bundled sample PDF, provides browser file reading |
| `src/app.js` | Workspace UI, review flow, uploads, calculation requests, PDF export |
| `backend/main.py` | FastAPI endpoints, strict validation, SQLite audit/calculation persistence, downloadable PDF report |
| `styles.css` / `index.html` | Responsive dashboard and document-review UI, no build step |
| `tests/` | Calculation, verification-gate, invalid-input, provenance, scenario-isolation, and extraction-boundary tests |

> A future AI/OCR provider can replace or extend the extraction interface — but it must only return *proposals*. It is never given authority to verify values or calculate compliance results.

---

## Tech stack

`Vanilla JS` · `FastAPI` · `Pydantic` · `SQLite` · `pdf.js` — no build step on the frontend, no external API key required.

---

## Run locally

**Requirements:** Python 3.9+, Node.js 18+

```powershell
python -m pip install -r requirements.txt
npm start
```

Open **http://localhost:4173** — FastAPI serves the frontend and API from one origin.

```powershell
npm run build          # frontend asset build + syntax check
npm test                # frontend/domain tests
npm run test:backend    # backend tests
```

---

## How GitHub Copilot was used

- **Generating components:** scaffolding the dashboard, document-review, provenance panel, and audit timeline as focused UI modules
- **Implementing validation:** the human-verification gate and unit/numeric checks in the calculation domain
- **Writing tests:** deterministic calculation, invalid-input, and verification-gate tests, written alongside each rule added
- **Debugging:** tracing failures through browser console errors and focused test output
- **Refactoring:** keeping rule logic separate from DOM rendering so future sector rules stay independently testable
- **Documentation:** this README, kept in sync with actual run commands and demo flow

---

## Scope & limitations

- This MVP does **not** call an LLM, OCR service, or external CBAM API — extraction proposals are a deterministic demo sample
- Generated values are **illustrative**, not official regulatory defaults
- JSON/PDF reports are audit-trace demonstrations, **not official filings**
- Current scope: one sample iron & steel calculation. Roadmap: additional CBAM sectors, a versioned rule archive, and ERP/customs-workflow integrations

---

**CBAM-AuditTrace** · 
