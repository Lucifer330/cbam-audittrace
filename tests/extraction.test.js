import test from "node:test";
import assert from "node:assert/strict";
import { extractDocument } from "../src/extraction.js";

test("demo extraction returns pending proposals from the local fallback", async () => {
  const extraction = await extractDocument({
    mode: "demo_fixture",
    now: new Date("2026-02-14T10:31:00.000Z"),
  });
  assert.equal(extraction.status, "complete");
  assert.equal(extraction.provider, "deterministic-demo-fallback");
  assert.equal(extraction.fields.length, 6);
  assert.ok(extraction.fields.every((field) => field.status === "pending" && field.verifiedValue === null));
});

test("uploaded PDFs are not presented as extracted when no provider is configured", async () => {
  const extraction = await extractDocument({ mode: "uploaded_pdf", fileName: "supplier.pdf" });
  assert.equal(extraction.status, "unavailable");
  assert.equal(extraction.provider, "not-configured");
  assert.deepEqual(extraction.fields, []);
  assert.match(extraction.message, /no values were fabricated/);
});
