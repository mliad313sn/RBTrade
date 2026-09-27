"""Goal 10: quant joins the caller's trace (W3C traceparent) and exports spans."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from kora_quant.app import create_app
from kora_quant.config import Settings
from kora_quant.tracing import JsonLinesSpanExporter, build_provider

TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT = "00f067aa0ba902b7"


def _settings() -> Settings:
    return Settings(env="test", live_trading_enabled=False, port=0)


def test_request_span_is_a_child_of_the_callers_traceparent(tmp_path: Path) -> None:
    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    out = tmp_path / "spans.jsonl"
    provider.add_span_processor(SimpleSpanProcessor(JsonLinesSpanExporter(str(out))))
    with TestClient(create_app(_settings(), tracer_provider=provider)) as client:
        r = client.post(
            "/mc/project",
            json={"paths": 500},
            headers={"traceparent": f"00-{TRACE}-{PARENT}-01"},
        )
        assert r.status_code == 200
        assert client.get("/health").status_code == 200
    spans = memory.get_finished_spans()
    assert [s.name for s in spans] == ["POST /mc/project"]  # /health is not traced
    ctx = spans[0].get_span_context()
    assert ctx is not None
    assert format(ctx.trace_id, "032x") == TRACE
    assert spans[0].parent is not None
    assert format(spans[0].parent.span_id, "016x") == PARENT
    line = json.loads(out.read_text().splitlines()[0])
    assert line["traceId"] == TRACE
    assert line["parentSpanId"] == PARENT
    assert line["attributes"]["http.response.status_code"] == 200


def test_tracing_is_off_without_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.delenv("KORA_OTEL_FILE", raising=False)
    assert build_provider() is None


def test_file_provider_from_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setenv("KORA_OTEL_FILE", str(tmp_path / "x.jsonl"))
    assert build_provider() is not None
