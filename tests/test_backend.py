import io
import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "test.sqlite3")
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path / "uploads")
    main.initialize_database()
    with TestClient(main.app) as test_client:
        yield test_client


def valid_calculation(**overrides):
    payload = {
        "document_id": "demo-invoice",
        "net_mass": 1000,
        "net_mass_unit": "t",
        "emission_factor": 1.9,
        "emission_factor_unit": "tCO₂e/t",
        "net_mass_verified": True,
        "emission_factor_verified": True,
        "source_field_ids": ["net_mass", "emissions_value"],
    }
    payload.update(overrides)
    return payload


def verify_calculation_inputs(client, **overrides):
    fields = [
        {
            "document_id": "demo-invoice",
            "field_id": "net_mass",
            "value": "1,000",
            "unit": "t",
            "source_page": 1,
            "actor": "Demo auditor",
        },
        {
            "document_id": "demo-invoice",
            "field_id": "emissions_value",
            "value": "1.9",
            "unit": "tCO₂e/t",
            "source_page": 1,
            "actor": "Demo auditor",
        },
    ]
    for payload in fields:
        payload.update(overrides)
        response = client.post("/api/fields/verify", json=payload)
        assert response.status_code == 201, response.text


def test_health_reports_implemented_security_controls(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["security"]["server_side_validation"] is True


def test_verified_fields_are_read_back_from_server_storage(client):
    assert client.get("/api/documents/demo-invoice/verified-fields").json() == {"fields": []}
    response = client.post(
        "/api/fields/verify",
        json={
            "document_id": "demo-invoice",
            "field_id": "net_mass",
            "value": "1,000",
            "unit": "t",
            "source_page": 1,
        },
    )
    assert response.status_code == 201
    fields = client.get("/api/documents/demo-invoice/verified-fields").json()["fields"]
    assert fields[0]["value"] == "1,000"
    assert fields[0]["verified_by"] == "Demo auditor"


def test_private_project_files_are_not_served_as_static_assets(client):
    assert client.get("/tests/test_backend.py").status_code == 404
    assert client.get("/backend/main.py").status_code == 404
    assert client.get("/data/audittrace.sqlite3").status_code == 404


def test_upload_accepts_pdf_and_stores_generated_safe_name(client):
    response = client.post(
        "/api/documents",
        files={"file": ("supplier invoice.pdf", io.BytesIO(b"%PDF-1.4\nfixture"), "application/pdf")},
    )
    assert response.status_code == 201
    stored = list(main.UPLOAD_DIR.glob("*.pdf"))
    assert len(stored) == 1
    assert stored[0].name != "supplier invoice.pdf"
    document_id = response.json()["document_id"]
    served = client.get(f"/api/documents/{document_id}/file")
    assert served.status_code == 200
    assert served.content.startswith(b"%PDF-1.4")


@pytest.mark.parametrize(
    ("filename", "mime", "content", "status"),
    [
        ("../../unsafe.pdf", "application/pdf", b"%PDF-1.4\n", 400),
        ("invoice.txt", "text/plain", b"not a pdf", 400),
        ("invoice.pdf", "text/plain", b"%PDF-1.4\n", 415),
        ("invoice.pdf", "application/pdf", b"not a pdf", 415),
    ],
)
def test_upload_rejects_unsafe_or_unsupported_documents(client, filename, mime, content, status):
    response = client.post(
        "/api/documents",
        files={"file": (filename, io.BytesIO(content), mime)},
    )
    assert response.status_code == status


def test_upload_rejects_oversized_documents(client):
    response = client.post(
        "/api/documents",
        files={"file": ("large.pdf", io.BytesIO(b"%PDF-" + b"x" * main.MAX_UPLOAD_BYTES), "application/pdf")},
    )
    assert response.status_code == 413


def test_calculation_requires_verified_inputs_and_supported_units(client):
    blocked = client.post(
        "/api/calculations",
        json=valid_calculation(emission_factor_verified=False),
    )
    assert blocked.status_code == 422
    unsupported = client.post(
        "/api/calculations",
        json=valid_calculation(net_mass_unit="kg"),
    )
    assert unsupported.status_code == 422


def test_calculation_is_deterministic_and_audited(client):
    verify_calculation_inputs(client)
    first = client.post("/api/calculations", json=valid_calculation())
    second = client.post("/api/calculations", json=valid_calculation())
    assert first.status_code == second.status_code == 201
    assert first.json()["result"] == second.json()["result"] == 1900
    assert first.json()["rule_version"] == "v2026.1"
    assert first.json()["audit_event_id"]


def test_calculation_rejects_unverified_or_mismatched_values(client):
    assert client.post("/api/calculations", json=valid_calculation()).status_code == 422
    verify_calculation_inputs(client)
    assert client.post("/api/calculations", json=valid_calculation(net_mass=900)).status_code == 422


@pytest.mark.parametrize(
    ("field_id", "value", "unit"),
    [
        ("net_mass", "not-a-number", "t"),
        ("net_mass", "1000", "kg"),
        ("emissions_value", "NaN", "tCO₂e/t"),
    ],
)
def test_field_verification_validates_numeric_fields_and_units(client, field_id, value, unit):
    response = client.post(
        "/api/fields/verify",
        json={
            "document_id": "demo-invoice",
            "field_id": field_id,
            "value": value,
            "unit": unit,
            "source_page": 1,
        },
    )
    assert response.status_code == 422


def test_invalid_calculation_payload_is_rejected(client):
    response = client.post(
        "/api/calculations",
        json=valid_calculation(unexpected="not allowed"),
    )
    assert response.status_code == 422


def test_audit_events_cannot_be_updated_or_deleted(client, tmp_path, monkeypatch):
    client.post("/api/events", json={"event_type": "field_verified", "detail": "net_mass"})
    with sqlite3.connect(main.DB_PATH) as connection:
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("UPDATE audit_events SET detail = 'changed'")
        with pytest.raises(sqlite3.IntegrityError, match="immutable"):
            connection.execute("DELETE FROM audit_events")


def test_pdf_report_is_a_downloadable_pdf(client):
    verify_calculation_inputs(client)
    calculation_response = client.post("/api/calculations", json=valid_calculation())
    assert calculation_response.status_code == 201
    response = client.post(
        "/api/reports/pdf",
        json={
            "document_id": "demo-invoice",
            "supplier": "Demo Steel Supplier",
            "product": "Steel Coil",
            "cn_code": "7208.39",
            "file_name": "demo_supplier_invoice.pdf",
            "net_mass": 1000,
            "emission_factor": 1.9,
            "result": 1900,
            "formula": "1,000 × 1.9",
            "verified": True,
            "source_page": 1,
        },
    )
    assert response.status_code == 200
    assert response.content.startswith(b"%PDF-1.4")


def test_pdf_report_requires_server_verified_calculation(client):
    response = client.post(
        "/api/reports/pdf",
        json={
            "document_id": "demo-invoice",
            "supplier": "Demo Steel Supplier",
            "product": "Steel Coil",
            "cn_code": "7208.39",
            "file_name": "demo_supplier_invoice.pdf",
            "net_mass": 1000,
            "emission_factor": 1.9,
            "result": 1900,
            "formula": "1,000 × 1.9",
            "verified": True,
            "source_page": 1,
        },
    )
    assert response.status_code == 422


def test_report_rejects_missing_cn_code(client):
    response = client.post(
        "/api/reports/pdf",
        json={
            "document_id": "demo-invoice",
            "supplier": "Demo Steel Supplier",
            "product": "Steel Coil",
            "cn_code": "",
            "file_name": "demo_supplier_invoice.pdf",
            "net_mass": 1000,
            "emission_factor": 1.9,
            "result": 1900,
            "formula": "1,000 × 1.9",
            "verified": True,
            "source_page": 1,
        },
    )
    assert response.status_code == 422
