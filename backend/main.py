from __future__ import annotations

import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field


ROOT = Path(__file__).resolve().parent.parent
ASSET_ROOT = ROOT / "dist" if (ROOT / "dist" / "index.html").is_file() else ROOT
DB_PATH = Path(os.environ.get("CBAM_DATABASE", ROOT / "data" / "audittrace.sqlite3"))
UPLOAD_DIR = Path(os.environ.get("CBAM_UPLOAD_DIR", ROOT / "data" / "uploads"))
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
RULE_ID = "EMBEDDED_EMISSIONS"
RULE_VERSION = "v2026.1"
PORT = int(os.environ.get("PORT", "4173"))
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "CBAM_CORS_ORIGINS",
        "http://localhost:4173,http://127.0.0.1:4173",
    ).split(",")
    if origin.strip()
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database() -> None:
    with connect_db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                original_name TEXT NOT NULL,
                stored_name TEXT NOT NULL UNIQUE,
                uploaded_at TEXT NOT NULL,
                byte_size INTEGER NOT NULL CHECK(byte_size > 0 AND byte_size <= 15728640)
            );
            CREATE TABLE IF NOT EXISTS calculations (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES documents(id),
                net_mass REAL NOT NULL CHECK(net_mass > 0),
                emission_factor REAL NOT NULL CHECK(emission_factor > 0),
                result REAL NOT NULL CHECK(result > 0),
                rule_id TEXT NOT NULL,
                rule_version TEXT NOT NULL,
                formula TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS verified_fields (
                document_id TEXT NOT NULL,
                field_id TEXT NOT NULL CHECK(field_id IN (
                    'supplier_name', 'country', 'product', 'CN_code', 'net_mass', 'emissions_value'
                )),
                value TEXT NOT NULL CHECK(length(value) > 0 AND length(value) <= 500),
                unit TEXT NOT NULL CHECK(length(unit) <= 32),
                source_page INTEGER NOT NULL CHECK(source_page > 0),
                verified_by TEXT NOT NULL,
                verified_at TEXT NOT NULL,
                PRIMARY KEY (document_id, field_id)
            );
            CREATE TABLE IF NOT EXISTS audit_events (
                id TEXT PRIMARY KEY,
                document_id TEXT,
                event_type TEXT NOT NULL,
                actor TEXT NOT NULL,
                detail TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS audit_events_no_update
            BEFORE UPDATE ON audit_events BEGIN
                SELECT RAISE(ABORT, 'audit events are immutable');
            END;
            CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
            BEFORE DELETE ON audit_events BEGIN
                SELECT RAISE(ABORT, 'audit events are immutable');
            END;
            """
        )


class CalculationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    net_mass: float = Field(gt=0, allow_inf_nan=False)
    net_mass_unit: Literal["t"]
    emission_factor: float = Field(gt=0, allow_inf_nan=False)
    emission_factor_unit: Literal["tCO₂e/t"]
    net_mass_verified: Literal[True]
    emission_factor_verified: Literal[True]
    source_field_ids: list[Literal["net_mass", "emissions_value"]] = Field(
        min_length=2, max_length=2
    )


class VerificationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    field_id: Literal[
        "supplier_name", "country", "product", "CN_code", "net_mass", "emissions_value"
    ]
    value: str = Field(min_length=1, max_length=500)
    unit: str = Field(default="", max_length=32)
    source_page: int = Field(ge=1, le=10000)
    actor: str = Field(default="Demo auditor", min_length=1, max_length=80)


class VerificationRevocationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    field_id: Literal[
        "supplier_name", "country", "product", "CN_code", "net_mass", "emissions_value"
    ]
    action: Literal["rejected", "reopened"]
    actor: str = Field(default="Demo auditor", min_length=1, max_length=80)
    detail: str = Field(default="", max_length=500)


class AuditEventInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str | None = Field(default=None, max_length=128)
    event_type: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_]+$")
    actor: str = Field(default="Demo auditor", min_length=1, max_length=80)
    detail: str = Field(default="", max_length=500)


class ReportInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    supplier: str = Field(max_length=200)
    product: str = Field(max_length=200)
    cn_code: str = Field(min_length=1, max_length=40)
    file_name: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9._ -]*\.pdf$")
    net_mass: float = Field(gt=0, allow_inf_nan=False)
    emission_factor: float = Field(gt=0, allow_inf_nan=False)
    result: float = Field(gt=0, allow_inf_nan=False)
    formula: str = Field(max_length=120)
    verified: Literal[True]
    source_page: int = Field(ge=1)


def write_event(
    event_type: str,
    actor: str,
    detail: str,
    document_id: str | None = None,
) -> str:
    event_id = str(uuid.uuid4())
    with connect_db() as connection:
        connection.execute(
            "INSERT INTO audit_events (id, document_id, event_type, actor, detail, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (event_id, document_id, event_type, actor, detail, utc_now()),
        )
    return event_id


def pdf_response(lines: list[str], filename: str) -> Response:
    def escape(value: str) -> str:
        return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    content = ["BT /F1 11 Tf 54 740 Td"]
    for index, line in enumerate(lines):
        if index:
            content.append("0 -24 Td")
        content.append(f"({escape(line)}) Tj")
    content.append("ET")
    stream = "\n".join(content).encode("latin-1", errors="replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, item in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{number} 0 obj\n".encode() + item + b"\nendobj\n")
    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF".encode()
    )
    return Response(
        bytes(pdf),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


app = FastAPI(title="CBAM-AuditTrace", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
initialize_database()


@app.get("/api/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "security": {
            "file_validation": True,
            "server_side_validation": True,
            "secrets_in_frontend": False,
            "audit_logging": True,
            "external_provider_configured": False,
        },
    }


def ensure_audit_document(document_id: str) -> None:
    created_at = utc_now()
    with connect_db() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO documents (id, original_name, stored_name, uploaded_at, byte_size) "
            "VALUES (?, ?, ?, ?, ?)",
            (document_id, "Illustrative demo invoice", f"demo-{document_id}", created_at, 1),
        )


@app.post("/api/fields/verify", status_code=201)
def verify_field(payload: VerificationInput) -> dict[str, str]:
    value = payload.value.strip()
    if not value or any(ord(character) < 32 and character not in "\t" for character in value):
        raise HTTPException(status_code=422, detail="Field value is empty or contains unsupported control characters.")
    required_units = {"net_mass": "t", "emissions_value": "tCO₂e/t"}
    if payload.field_id in required_units and payload.unit != required_units[payload.field_id]:
        raise HTTPException(status_code=422, detail=f"Unsupported unit for {payload.field_id}.")
    if payload.field_id in ("net_mass", "emissions_value"):
        try:
            numeric_value = float(value.replace(",", ""))
        except ValueError as error:
            raise HTTPException(status_code=422, detail=f"{payload.field_id} must be numeric.") from error
        if numeric_value <= 0 or numeric_value == float("inf") or numeric_value != numeric_value:
            raise HTTPException(status_code=422, detail=f"{payload.field_id} must be a positive finite number.")

    ensure_audit_document(payload.document_id)
    verified_at = utc_now()
    with connect_db() as connection:
        connection.execute(
            "INSERT INTO verified_fields (document_id, field_id, value, unit, source_page, verified_by, verified_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(document_id, field_id) DO UPDATE SET "
            "value=excluded.value, unit=excluded.unit, source_page=excluded.source_page, "
            "verified_by=excluded.verified_by, verified_at=excluded.verified_at",
            (
                payload.document_id,
                payload.field_id,
                value,
                payload.unit,
                payload.source_page,
                payload.actor,
                verified_at,
            ),
        )
    event_id = write_event(
        "field_verified",
        payload.actor,
        f"Human-verified {payload.field_id}: {value} {payload.unit}".strip(),
        payload.document_id,
    )
    return {"field_id": payload.field_id, "verified_at": verified_at, "audit_event_id": event_id}


@app.get("/api/documents/{document_id}/verified-fields")
def get_verified_fields(document_id: str) -> dict[str, list[dict[str, object]]]:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", document_id):
        raise HTTPException(status_code=404, detail="Document not found.")
    with connect_db() as connection:
        rows = connection.execute(
            "SELECT field_id, value, unit, source_page, verified_by, verified_at "
            "FROM verified_fields WHERE document_id = ?",
            (document_id,),
        ).fetchall()
    return {"fields": [dict(row) for row in rows]}


@app.post("/api/fields/revoke", status_code=201)
def revoke_field_verification(payload: VerificationRevocationInput) -> dict[str, str]:
    with connect_db() as connection:
        connection.execute(
            "DELETE FROM verified_fields WHERE document_id = ? AND field_id = ?",
            (payload.document_id, payload.field_id),
        )
    event_id = write_event(
        f"field_{payload.action}",
        payload.actor,
        payload.detail or f"{payload.action.capitalize()} {payload.field_id}",
        payload.document_id,
    )
    return {"field_id": payload.field_id, "audit_event_id": event_id}


@app.post("/api/documents", status_code=201)
async def upload_document(file: UploadFile = File(...)) -> dict[str, object]:
    filename = file.filename or ""
    if (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,114}\.pdf", filename, re.IGNORECASE)
        or "/" in filename
        or "\\" in filename
        or ".." in filename
    ):
        raise HTTPException(status_code=400, detail="Unsafe filename. Use a plain PDF filename without path segments.")
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=415, detail="Unsupported document. Upload a PDF file.")

    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="PDF exceeds the 15 MB upload limit.")
    if not data.startswith(b"%PDF-"):
        raise HTTPException(status_code=415, detail="File content is not a valid PDF.")

    document_id = str(uuid.uuid4())
    stored_name = f"{document_id}.pdf"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stored_path = UPLOAD_DIR / stored_name
    stored_path.write_bytes(data)
    uploaded_at = utc_now()
    try:
        with connect_db() as connection:
            connection.execute(
                "INSERT INTO documents (id, original_name, stored_name, uploaded_at, byte_size) "
                "VALUES (?, ?, ?, ?, ?)",
                (document_id, filename, stored_name, uploaded_at, len(data)),
            )
        event_id = write_event("document_uploaded", "Demo auditor", f"Uploaded {filename}", document_id)
    except Exception:
        stored_path.unlink(missing_ok=True)
        raise
    return {
        "document_id": document_id,
        "file_name": filename,
        "uploaded_at": uploaded_at,
        "byte_size": len(data),
        "audit_event_id": event_id,
    }


@app.get("/api/documents/{document_id}/file")
def get_document_file(document_id: str) -> FileResponse:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", document_id):
        raise HTTPException(status_code=404, detail="Document not found.")
    with connect_db() as connection:
        document = connection.execute(
            "SELECT stored_name FROM documents WHERE id = ?",
            (document_id,),
        ).fetchone()
    if not document:
        raise HTTPException(status_code=404, detail="Document not found.")
    upload_root = UPLOAD_DIR.resolve()
    stored_path = (upload_root / document["stored_name"]).resolve()
    if not stored_path.is_relative_to(upload_root) or not stored_path.is_file():
        raise HTTPException(status_code=404, detail="Stored document is unavailable.")
    return FileResponse(stored_path, media_type="application/pdf", headers={"Content-Disposition": "inline"})


@app.post("/api/calculations", status_code=201)
def create_calculation(payload: CalculationInput) -> dict[str, object]:
    if sorted(payload.source_field_ids) != ["emissions_value", "net_mass"]:
        raise HTTPException(status_code=422, detail="Calculation requires net mass and emission factor source fields.")
    with connect_db() as connection:
        verified = {
            row["field_id"]: row
            for row in connection.execute(
                "SELECT field_id, value, unit FROM verified_fields WHERE document_id = ?",
                (payload.document_id,),
            ).fetchall()
        }
    mass = verified.get("net_mass")
    factor = verified.get("emissions_value")
    if not mass or not factor:
        raise HTTPException(status_code=422, detail="Calculation is locked until net mass and emission factor are verified on the server.")
    if (
        mass["unit"] != payload.net_mass_unit
        or factor["unit"] != payload.emission_factor_unit
        or float(mass["value"].replace(",", "")) != payload.net_mass
        or float(factor["value"].replace(",", "")) != payload.emission_factor
    ):
        raise HTTPException(status_code=422, detail="Calculation inputs do not match the current server-verified field values.")
    result = round(payload.net_mass * payload.emission_factor, 6)
    calculation_id = str(uuid.uuid4())
    created_at = utc_now()
    formula = f"{payload.net_mass:,.6g} × {payload.emission_factor:,.6g}"
    with connect_db() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO documents (id, original_name, stored_name, uploaded_at, byte_size) "
            "VALUES (?, ?, ?, ?, ?)",
            (payload.document_id, "Illustrative demo invoice", f"demo-{payload.document_id}", created_at, 1),
        )
        connection.execute(
            "INSERT INTO calculations (id, document_id, net_mass, emission_factor, result, rule_id, rule_version, formula, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                calculation_id,
                payload.document_id,
                payload.net_mass,
                payload.emission_factor,
                result,
                RULE_ID,
                RULE_VERSION,
                formula,
                created_at,
            ),
        )
    event_id = write_event(
        "calculation_generated",
        "Demo auditor",
        f"{RULE_ID} {RULE_VERSION}: {formula} = {result:g} tCO2e",
        payload.document_id,
    )
    return {
        "calculation_id": calculation_id,
        "document_id": payload.document_id,
        "result": result,
        "unit": "tCO₂e",
        "formula": formula,
        "rule_id": RULE_ID,
        "rule_version": RULE_VERSION,
        "created_at": created_at,
        "audit_event_id": event_id,
    }


@app.post("/api/events", status_code=201)
def create_audit_event(payload: AuditEventInput) -> dict[str, str]:
    event_id = write_event(payload.event_type, payload.actor, payload.detail, payload.document_id)
    return {"event_id": event_id}


@app.post("/api/reports/pdf")
def export_report_pdf(payload: ReportInput) -> Response:
    with connect_db() as connection:
        calculation = connection.execute(
            "SELECT document_id, net_mass, emission_factor, result, rule_version "
            "FROM calculations WHERE document_id = ? AND result = ? AND net_mass = ? AND emission_factor = ? "
            "ORDER BY created_at DESC LIMIT 1",
            (payload.document_id, payload.result, payload.net_mass, payload.emission_factor),
        ).fetchone()
        verified = connection.execute(
            "SELECT field_id, value, unit, source_page FROM verified_fields WHERE document_id = ?",
            (payload.document_id,),
        ).fetchall()
    values = {row["field_id"]: row for row in verified}
    if not calculation or not all(key in values for key in ("net_mass", "emissions_value")):
        raise HTTPException(status_code=422, detail="A PDF report requires a server-verified calculation.")
    if (
        float(values["net_mass"]["value"].replace(",", "")) != payload.net_mass
        or float(values["emissions_value"]["value"].replace(",", "")) != payload.emission_factor
        or values["net_mass"]["unit"] != "t"
        or values["emissions_value"]["unit"] != "tCO₂e/t"
        or calculation["result"] != payload.result
        or values["emissions_value"]["source_page"] != payload.source_page
        or payload.formula != f"{payload.net_mass:,.6g} × {payload.emission_factor:,.6g}"
    ):
        raise HTTPException(status_code=422, detail="Report values do not match server-verified calculation inputs.")
    lines = [
        "CBAM-AuditTrace - Audit Record",
        "Illustrative sample only - not an official CBAM filing.",
        "",
        f"Source document: {payload.file_name}",
        f"Supplier: {payload.supplier}",
        f"Product: {payload.product}",
        f"CN code: {payload.cn_code}",
        f"Source page: {payload.source_page}",
        f"Verified net mass: {payload.net_mass:g} t",
        f"Verified emission factor: {payload.emission_factor:g} tCO2e/t",
        f"Rule: {RULE_ID} {RULE_VERSION}",
        f"Formula: {payload.formula}",
        f"Result: {payload.result:g} tCO2e",
        "Verification status: Human verified",
        "Verify against current official CBAM guidance before compliance use.",
    ]
    write_event("report_exported", "Demo auditor", f"Exported PDF for {payload.file_name}")
    return pdf_response(lines, "cbam-audit-report.pdf")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(ASSET_ROOT / "index.html")


@app.get("/styles.css")
def stylesheet() -> FileResponse:
    return FileResponse(ASSET_ROOT / "styles.css", media_type="text/css")


app.mount("/src", StaticFiles(directory=ASSET_ROOT / "src"), name="frontend-source")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
