import { createDemoDocument } from "./domain.js";

export async function extractDocument({ mode, fileName = "", now = new Date() }) {
  if (mode === "demo_fixture") {
    const document = createDemoDocument(now);
    return {
      status: "complete",
      provider: "deterministic-demo-fallback",
      document,
      fields: document.fields,
    };
  }

  if (mode === "uploaded_pdf") {
    return {
      status: "unavailable",
      provider: "not-configured",
      document: null,
      fields: [],
      message: `No OCR/AI provider is configured for ${fileName}; no values were fabricated.`,
    };
  }

  throw new Error(`Unsupported extraction mode: ${mode}`);
}
