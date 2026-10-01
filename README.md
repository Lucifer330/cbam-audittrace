# CBAM-AuditTrace

**Trace every CBAM number back to its source.**

A local-first MVP for reviewing supplier evidence, human-verifying proposed CBAM inputs, calculating a sample iron/steel result deterministically, and exporting a traceable audit record.

> **Illustrative sample only — not an official CBAM filing.** This demonstration implements only the supplied sample calculation. Verify against current official CBAM guidance before compliance use.

## Run locally

Requirements: Python 3.9+, Node.js 18+, and the Python packages listed in `requirements.txt`. No external API key is needed.

```powershell
npm start
```

Open <http://localhost:4173>. The FastAPI service serves the frontend and API from one origin. To install Python dependencies if needed:

```powershell
python -m pip install -r requirements.txt
```

The frontend build copies only browser assets into `dist/` and checks JavaScript syntax:

```powershell
npm run build
```

Run the frontend/domain and backend tests:

```powershell
npm test
npm run test:backend
```

## Demo flow

1. Choose **Load demo invoice**. The app generates a small, valid sample PDF in the browser and displays its source page with selectable evidence.
2. Select a field, inspect its page, source text, and coordinates, then confirm or edit/reject the proposal. Every proposal begins pending review.
3. Confirm **Net mass** and **Emission factor**. The Calculate action stays locked until those required inputs are human verified.
4. Calculate **1,000 × 1.9 = 1,900 tCO₂e**, then click the result to inspect the source → verified input → versioned rule → formula → result chain.
5. Change the what-if factor to `1.6`; the separate scenario shows `1,600 tCO₂e` and does not modify the verified result.
6. Export the document's audit report as JSON or inspect the activity timeline.

The dashboard starts empty and its counts are based on workspace records, not fabricated metrics. Browser review state persists in local storage; uploaded PDFs are validated and stored by the local API under generated UUID filenames. The sample document remains a local illustrative fallback.

## Architecture

- `src/extraction.js` is the extraction-service boundary: it selects the deterministic demo fallback or explicitly reports that uploaded-PDF extraction is not configured.
- `src/domain.js` contains the versioned rule definition, verification gate, numeric/unit validation, deterministic calculator, scenario calculator, exceptions, and report serialization. It has no AI or network dependency.
- `src/pdf.js` generates the bundled sample PDF and provides a browser file reader.
- `src/app.js` owns the workspace UI and review flow, with uploads, calculation requests, security status, and PDF exports connected to the API. Extraction proposals are explicitly limited to the bundled deterministic sample. Arbitrary uploaded PDFs are previewed but not represented as OCR-extracted; users can add source fields manually.
- `backend/main.py` provides FastAPI endpoints, strict upload and payload validation, SQLite audit/calculation persistence, and a downloadable PDF report.
- `styles.css` and `index.html` provide the responsive dashboard and document-review UI without a build step.
- `tests/domain.test.js` exercises calculation, verification gates, invalid inputs, provenance/report data, scenario isolation, and exceptions. `tests/extraction.test.js` checks that only demo data is proposed when no provider is configured; `tests/pdf.test.js` verifies the generated PDF structure.

A future AI/OCR provider can replace or extend the extraction-service interface, but it must return proposals only. It must not be given authority to verify values or calculate compliance results.

## How GitHub Copilot was used

This project is designed to make the development workflow demonstrable:

- **Generating components:** scaffold and refine the dashboard, document review, provenance drawer, and audit timeline as focused UI modules.
- **Implementing validation:** encode the human-verification gate and supported-unit checks in the calculation domain.
- **Writing tests:** add deterministic calculation, invalid-input, and verification-gate tests before extending the rule set.
- **Debugging:** trace demo failures from browser console errors and focused test output rather than hiding errors behind success fallbacks.
- **Refactoring:** keep rule logic separate from DOM rendering so future sector rules remain independently testable.
- **Documentation:** update this README with the actual run commands, data boundaries, and demo flow.

## Scope and limitations

This MVP does not call an LLM, OCR service, or external CBAM API. The generated sample values are illustrative and are not regulatory defaults. The API stores uploaded PDFs locally and the JSON/PDF reports are audit-trace demonstrations, not official filings.
