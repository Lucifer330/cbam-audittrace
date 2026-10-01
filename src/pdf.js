const SAMPLE_LINES = [
  "DEMO STEEL SUPPLIER",
  "ILLUSTRATIVE SUPPLIER INVOICE",
  "Invoice number: DEMO-2026-014",
  "Invoice date: 14 February 2026",
  "Supplier: Demo Steel Supplier",
  "Country of origin: India",
  "Product: Hot rolled steel coil",
  "CN code: 7208.39 (illustrative)",
  "Net mass: 1,000 t",
  "Specific embedded emissions: 1.9 tCO2e/t",
  "Declared values are illustrative sample data only.",
  "Not an official CBAM filing.",
];

function escapePdfText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function createSamplePdfDataUrl() {
  const textCommands = SAMPLE_LINES.map((line, index) =>
    `BT /F1 ${index < 2 ? 17 : 11} Tf 56 ${750 - index * 38} Td (${escapePdfText(line)}) Tj ET`
  ).join("\n");
  const stream = `${textCommands}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(new TextEncoder().encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = new TextEncoder().encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return `data:application/pdf;base64,${btoa(unescape(encodeURIComponent(pdf)))}`;
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}.`)));
    reader.readAsDataURL(file);
  });
}
