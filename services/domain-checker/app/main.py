"""FastAPI + FastMCP ASGI entrypoint for the domain checker.

Run locally:
  uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

MCP Streamable HTTP is mounted at /mcp. The MCP app's lifespan MUST be
passed into FastAPI so the session manager initializes correctly.
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from fastmcp import FastMCP

from app.domain_checker import DomainChecker
from app.llms import MCP_DISCOVERY, build_llms_txt
from app.metrics import metrics


def _record_metrics_async(source: str, domain_count: int) -> None:
    """Postgres metrics writes must not block the domain-check hot path (~100ms+)."""

    def _run() -> None:
        try:
            metrics.record(source, domain_count=domain_count)  # type: ignore[arg-type]
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True, name="domain-metrics").start()

SERVICE_TITLE = "forwardslashdot domain checker"
SERVICE_DESCRIPTION = (
    "Domain availability for forwardslashdot.com — RDAP-first with DNS fallback. "
    "REST at /api/domain and MCP tool check_domains at /mcp."
)

# ---------------------------------------------------------------------------
# Shared checker (created in lifespan so HTTP client + cache live with the app)
# ---------------------------------------------------------------------------
checker: DomainChecker | None = None

mcp = FastMCP(
    name=SERVICE_TITLE,
    instructions=(
        "Use check_domains to see whether domain names are available or already "
        "registered. Pass a list of domains (batch capped). Optional affiliate "
        "links appear only when the server operator configured AFFILIATE_* env vars."
    ),
)


@mcp.tool
async def check_domains(domains: list[str] | str) -> dict[str, Any]:
    """Check domain availability (RDAP first, DNS NS/SOA fallback).

    Args:
        domains: List of domain names, or a single comma-separated string.
                 Batch is capped (~25 names per call).
    """
    if checker is None:
        return {"error": "service not ready", "results": []}
    if isinstance(domains, str):
        domain_list = checker.parse_batch(domains)
    else:
        domain_list = list(domains)[: checker.batch_cap]
    _record_metrics_async("mcp", len(domain_list))
    return await checker.check_domains(domain_list)


# Create MCP ASGI app with path="/" because we mount at /mcp.
mcp_app = mcp.http_app(path="/")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Combine our resources with the FastMCP session-manager lifespan."""
    global checker
    checker = DomainChecker()
    app.state.checker = checker
    # Warm IANA RDAP bootstrap in the background (seeded bases already cover .com etc.).
    checker.kick_bootstrap_refresh()
    # Nested mount lifespans are not run by Starlette/FastAPI — drive MCP's
    # lifespan explicitly (required for Streamable HTTP session manager).
    async with mcp_app.lifespan(app):
        try:
            yield
        finally:
            await checker.aclose()
            checker = None


app = FastAPI(
    title=SERVICE_TITLE,
    description=SERVICE_DESCRIPTION,
    version="1.0.0",
    lifespan=lifespan,
)

# Browser clients on the marketing site (instant domain search).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://www.forwardslashdot.com",
        "https://forwardslashdot.com",
        "https://forwardslashdot.pages.dev",
    ],
    allow_origin_regex=r"https://[a-z0-9-]+\.forwardslashdot\.pages\.dev",
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Accept", "Content-Type"],
    max_age=86400,
)


@app.get("/health", tags=["ops"])
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "domain-checker"}


@app.get("/stats", tags=["ops"])
async def stats() -> dict[str, Any]:
    """Aggregate domain-check request counts (HTTP + MCP). No query logs."""
    return metrics.snapshot()


@app.get("/api/domain", tags=["domains"])
async def api_domain(
    request: Request,
    q: str = Query(
        ...,
        min_length=1,
        description="Comma-separated domain names (batch capped at ~25).",
        examples=["example.com,available-test-xyz123.com"],
    ),
) -> JSONResponse:
    """Check one or more domains. Shares logic with the MCP `check_domains` tool."""
    t0 = time.perf_counter()
    dc = getattr(request.app.state, "checker", None) or checker
    if dc is None:
        raise HTTPException(status_code=503, detail="service not ready")
    raw_parts = [p.strip() for p in q.split(",") if p.strip()]
    # Cap for counting matches DomainChecker.check_domains truncation.
    capped = raw_parts[: dc.batch_cap]
    _record_metrics_async("http", len(capped))
    payload = await dc.check_domains(raw_parts)
    payload["timing_ms"] = int((time.perf_counter() - t0) * 1000)

    # Short shared cache: speeds repeat keystrokes / edge hits without lying for long.
    all_cached = bool(payload.get("results")) and all(
        r.get("cached") for r in payload["results"]
    )
    definitive = all(
        r.get("status") in ("available", "registered") for r in payload.get("results", [])
    )
    if definitive:
        # s-maxage for Cloudflare; browser max-age short for freshness.
        cache_header = "public, max-age=15, s-maxage=45" if not all_cached else "public, max-age=30, s-maxage=60"
    else:
        cache_header = "no-store"

    return JSONResponse(
        payload,
        headers={
            "Cache-Control": cache_header,
            "X-Response-Time-Ms": str(payload["timing_ms"]),
        },
    )

@app.get("/llms.txt", response_class=PlainTextResponse, tags=["discovery"])
async def llms_txt(request: Request) -> PlainTextResponse:
    """llmstxt.org discovery document."""
    # Prefer configured public URL; else derive from the request.
    public = (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/")
    if not public:
        public = str(request.base_url).rstrip("/")
    body = build_llms_txt(base_url=public)
    return PlainTextResponse(body, media_type="text/plain; charset=utf-8")


@app.get("/.well-known/mcp.json", tags=["discovery"])
async def well_known_mcp(request: Request) -> JSONResponse:
    """MCP server discovery metadata (Notion-style /.well-known/mcp.json)."""
    public = (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/")
    if not public:
        public = str(request.base_url).rstrip("/")
    endpoint = MCP_DISCOVERY["endpoint"]
    if not endpoint.startswith("http"):
        endpoint = f"{public}{endpoint}"
    payload = {
        **MCP_DISCOVERY,
        "endpoint": endpoint,
        "transport": "streamable-http",
        "website": "https://forwardslashdot.com",
    }
    return JSONResponse(
        payload,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
        },
    )


# Mount MCP last so FastAPI routes take precedence for exact paths above.
app.mount("/mcp", mcp_app)


def create_app() -> FastAPI:
    """Factory for tests / alternative runners."""
    return app
