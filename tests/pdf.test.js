import test from "node:test";
import assert from "node:assert/strict";
import { createSamplePdfDataUrl } from "../src/pdf.js";

test("generates a valid single-page illustrative PDF fixture", () => {
  const url = createSamplePdfDataUrl();
  assert.match(url, /^data:application\/pdf;base64,/);
  const decoded = Buffer.from(url.split(",")[1], "base64").toString("utf8");
  assert.match(decoded, /^%PDF-1\.4/);
  assert.match(decoded, /xref\n0 6\n/);
  assert.match(decoded, /%%EOF$/);
  assert.match(decoded, /Specific embedded emissions: 1\.9 tCO2e\/t/);
  const entries = decoded.match(/xref\n0 6\n([\s\S]*?)trailer/)[1].trim().split("\n");
  for (let objectNumber = 1; objectNumber <= 5; objectNumber++) {
    const offset = Number(entries[objectNumber].slice(0, 10));
    assert.equal(decoded.slice(offset, offset + `${objectNumber} 0 obj`.length), `${objectNumber} 0 obj`);
  }
  assert.equal(Number(decoded.match(/startxref\n(\d+)/)[1]), decoded.indexOf("xref\n"));
});
