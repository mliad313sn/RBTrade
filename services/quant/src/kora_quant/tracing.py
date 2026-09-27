"""OpenTelemetry for the quant service (goal 10, B-507/B-603).

Each request runs in a server span whose parent is the caller's W3C `traceparent` (api or bot
runner), so api → quant and runner → quant are one trace. Enabled by OTEL_EXPORTER_OTLP_ENDPOINT
(collector) and/or KORA_OTEL_FILE (JSON lines, tests and drills). Structured logs keep the input
hash as before.
"""

from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable, Sequence

from fastapi import FastAPI, Request, Response
from opentelemetry import propagate, trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.trace import SpanKind


class JsonLinesSpanExporter(SpanExporter):
    """Appends one JSON line per finished span (same fields as the api's file exporter)."""

    def __init__(self, path: str) -> None:
        self.path = path

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        lines = []
        for s in spans:
            ctx = s.get_span_context()
            parent = s.parent
            lines.append(
                json.dumps(
                    {
                        "traceId": format(ctx.trace_id, "032x") if ctx else None,
                        "spanId": format(ctx.span_id, "016x") if ctx else None,
                        "parentSpanId": format(parent.span_id, "016x") if parent else None,
                        "name": s.name,
                        "service": s.resource.attributes.get("service.name"),
                        "startMs": (s.start_time or 0) / 1e6,
                        "durationMs": ((s.end_time or 0) - (s.start_time or 0)) / 1e6,
                        "attributes": dict(s.attributes or {}),
                    }
                )
            )
        with open(self.path, "a", encoding="utf-8") as f:
            f.write("".join(f"{line}\n" for line in lines))
        return SpanExportResult.SUCCESS


def build_provider() -> TracerProvider | None:
    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "").strip()
    path = os.environ.get("KORA_OTEL_FILE", "").strip()
    if not endpoint and not path:
        return None
    provider = TracerProvider(resource=Resource.create({"service.name": "kora-quant"}))
    if path:
        provider.add_span_processor(SimpleSpanProcessor(JsonLinesSpanExporter(path)))
    if endpoint:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    return provider


def instrument(app: FastAPI, provider: TracerProvider | None) -> None:
    """Adds the server-span middleware when a provider is configured (no-op otherwise)."""
    if provider is None:
        return
    tracer = provider.get_tracer("kora-quant")

    @app.middleware("http")
    async def otel_server_span(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.url.path == "/health":
            return await call_next(request)
        parent = propagate.extract(dict(request.headers))
        with tracer.start_as_current_span(
            f"{request.method} {request.url.path}", context=parent, kind=SpanKind.SERVER
        ) as span:
            span.set_attribute("http.request.method", request.method)
            span.set_attribute("url.path", request.url.path)
            response = await call_next(request)
            span.set_attribute("http.response.status_code", response.status_code)
            if response.status_code >= 500:
                span.set_status(trace.Status(trace.StatusCode.ERROR))
            return response
