"""FastAPI + FastMCP ASGI entrypoint for the domain checker.

Run locally:
  uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

MCP Streamable HTTP is mounted at /mcp. The MCP app's lifespan MUST be
passed into FastAPI so the session manager initializes correctly.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import threading
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from fastmcp import FastMCP

from app.domain_checker import DomainChecker
from app.endings import ending_of, row_for, sold_endings
from app.llms import MCP_DISCOVERY, api_catalog, build_llms_txt
from app.metrics import (
    country_from_headers,
    metrics,
    normalize_actor,
    normalize_area,
    normalize_country,
    normalize_day,
)


def _record_metrics_async(
    source: str,
    domain_count: int,
    *,
    area: str | None = None,
    country: str | None = None,
) -> None:
    """Postgres metrics writes must not block the domain-check hot path (~100ms+)."""

    def _run() -> None:
        try:
            metrics.record(
                source,
                domain_count=domain_count,
                area=area,
                country=country,
            )  # type: ignore[arg-type]
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True, name="domain-metrics").start()


def _record_endings_async(country: str | None, domains: list[str]) -> None:
    """Count the ending only. The name that was checked is discarded."""
    found = [ending for name in domains if (ending := ending_of(name))]
    if not found:
        return

    def _run() -> None:
        try:
            metrics.record_endings(country, found)
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True, name="ending-metrics").start()


def _record_hit_async(area: str | None, *, country: str | None = None) -> None:
    def _run() -> None:
        try:
            metrics.record_hit(area, country=country)
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True, name="area-hit").start()

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
        "registered. Pass full domains with any public ending (.si, .biz, .ai, "
        ".io, .com, .co.uk). Batch capped. Optional affiliate links appear only "
        "when the server operator configured AFFILIATE_* env vars."
    ),
)


@mcp.tool
async def check_domains(domains: list[str] | str) -> dict[str, Any]:
    """Check any public domain ending (RDAP first, DNS NS/SOA fallback).

    Args:
        domains: Full names such as studio.si or cafe.biz, as a list or one
                 comma-separated string. Batch is capped (~25 names per call).
    """
    if checker is None:
        return {"error": "service not ready", "results": []}
    if isinstance(domains, str):
        domain_list = checker.parse_batch(domains)
    else:
        domain_list = list(domains)[: checker.batch_cap]
    _record_metrics_async("mcp", len(domain_list), area="other")
    metrics.record_audience(
        "instant_domain_search",
        actor="llm",
        visitor=uuid.uuid4().hex,
        day=normalize_day(None),
        country=None,
    )
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


def stats_authorized(authorization: str | None) -> bool:
    """Open unless STATS_PASSWORD is set. Then require Authorization: Bearer."""
    expected = (os.getenv("STATS_PASSWORD") or "").strip()
    if not expected:
        return True
    presented = ""
    if authorization and authorization.lower().startswith("bearer "):
        presented = authorization[7:].strip()
    if len(presented) != len(expected):
        return False
    return hmac.compare_digest(presented, expected)


@app.get("/stats", tags=["ops"])
async def stats(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Aggregate counts by area and country. No query logs, IPs, or PII.

    When STATS_PASSWORD is set, callers must send Authorization: Bearer.
    """
    if not stats_authorized(authorization):
        raise HTTPException(status_code=401, detail="Stats password required")
    return metrics.snapshot()


_MODEL_UA = re.compile(
    r"GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Anthropic|"
    r"Perplexity|Google-Extended|Bytespider|Amazonbot|meta-externalagent|"
    r"cohere|YouBot|Phind|DuckAssist|CCBot|Applebot-Extended",
    re.IGNORECASE,
)
_UNFURL_UA = re.compile(
    r"Slackbot|Twitterbot|facebookexternalhit|Facebot|Discordbot|TelegramBot|"
    r"WhatsApp|LinkedInBot|Iframely|embedly|Pinterest|vkShare",
    re.IGNORECASE,
)
_BROWSER_UA = re.compile(r"Mozilla/|AppleWebKit|Chrome/|Firefox/|Safari/", re.IGNORECASE)


def request_actor(headers: Any) -> str:
    """A browser navigation is a person. A client with no browser headers is a model."""
    ua = headers.get("user-agent") or ""
    if _UNFURL_UA.search(ua):
        return "unfurl"
    if _MODEL_UA.search(ua):
        return "llm"
    if headers.get("sec-fetch-dest") or headers.get("sec-fetch-mode"):
        return "human"
    if _BROWSER_UA.search(ua):
        return "human"
    if not ua:
        return "human"
    return "llm"


def request_visitor(headers: Any) -> str:
    """Daily device key. The address is hashed and never stored."""
    day = normalize_day(None)
    ip = headers.get("cf-connecting-ip") or headers.get("fly-client-ip") or ""
    ua = headers.get("user-agent") or ""
    return hashlib.sha256(f"{day}|{ip}|{ua}".encode()).hexdigest()[:32]


@app.get("/api/hit", tags=["ops"])
async def api_hit(
    request: Request,
    area: str | None = Query(
        None,
        description="Site area label (instant_domain_search, world_time_converter).",
    ),
    source: str | None = Query(
        None,
        description="Alias for area (accepted for older clients).",
    ),
    actor: str | None = Query(
        None,
        description="human for a browser, llm for a model fetch.",
    ),
    visitor: str | None = Query(
        None,
        description="Opaque device id. The same id counts once per day.",
    ),
    day: str | None = Query(
        None,
        description="Local calendar day, YYYY-MM-DD.",
    ),
    country: str | None = Query(
        None,
        description="Optional ISO country code. Ignored unless it is a country code.",
    ),
) -> JSONResponse:
    """Record a non-PII utility hit attributed to a site area + coarse country."""
    # Prefer explicit query; fall back to Referer path heuristics (no raw URL stored).
    label = area or source
    if not label:
        referer = request.headers.get("referer") or request.headers.get("referrer") or ""
        low = referer.lower()
        if "instantdomainsearch" in low or "/utilities/domain" in low:
            label = "instant_domain_search"
        elif "worldtimeconverter" in low or "/utilities/time" in low:
            label = "world_time_converter"
    resolved_country = (
        normalize_country(country) if country else country_from_headers(request.headers)
    )
    actor_key = normalize_actor(actor)
    if visitor:
        recorded = metrics.record_audience(
            normalize_area(label),
            actor=actor_key,
            visitor=visitor,
            day=normalize_day(day),
            country=resolved_country,
        )
    else:
        _record_hit_async(normalize_area(label), country=resolved_country)
        recorded = True
    return JSONResponse(
        {
            "ok": True,
            "area": normalize_area(label),
            "country": resolved_country,
            "actor": actor_key,
            "recorded": recorded,
        },
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/tlds", tags=["domains"])
async def api_tlds() -> JSONResponse:
    """Endings Namecheap currently sells. Refreshed nightly; unchanged nights write nothing."""
    endings = list(sold_endings())
    return JSONResponse(
        {"count": len(endings), "endings": endings, "source": "namecheap"},
        headers={"Cache-Control": "public, max-age=3600"},
    )


@app.get("/api/endings", tags=["domains"])
async def api_endings(
    request: Request,
    country: str | None = Query(
        None,
        description="ISO country code. Defaults to the edge country. Returns the six endings to show.",
    ),
) -> JSONResponse:
    """Endings to show for a country. Counts are aggregates; no domains or IPs."""
    explicit = normalize_country(country) if country else ""
    resolved = explicit if explicit and explicit != "XX" else country_from_headers(request.headers)
    if resolved == "UK":
        resolved = "GB"
    endings, source = row_for(resolved, metrics.ending_counts(resolved))
    headers = (
        {"Cache-Control": "public, max-age=60"}
        if explicit and explicit != "XX"
        else {"Cache-Control": "private, max-age=60", "Vary": "CF-IPCountry"}
    )
    return JSONResponse(
        {"country": resolved, "endings": endings, "source": source},
        headers=headers,
    )


@app.get("/api/domain", tags=["domains"])
async def api_domain(
    request: Request,
    q: str = Query(
        ...,
        min_length=1,
        description="Full domain names, any public ending (.com, .si, .biz, .ai, .io, .co.uk). Comma-separated. Batch capped at ~25.",
        examples=["studio.si,cafe.biz"],
    ),
    area: str | None = Query(
        None,
        description="Site area for stats attribution (instant_domain_search, …).",
    ),
    source: str | None = Query(
        None,
        description="Alias for area when clients already send source=.",
    ),
    country: str | None = Query(
        None,
        description="ISO country code from the edge. Used only to count which endings a country checks.",
    ),
    warm: str | None = Query(
        None,
        description="1 when this is a background prefetch. Prefetches are not counted.",
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
    area_label = normalize_area(area or source or "instant_domain_search")
    explicit = normalize_country(country) if country else ""
    resolved_country = explicit if explicit and explicit != "XX" else country_from_headers(request.headers)
    if warm != "1":
        _record_metrics_async("http", len(capped), area=area_label, country=resolved_country)
        if request_actor(request.headers) == "llm":
            metrics.record_audience(
                area_label,
                actor="llm",
                visitor=request_visitor(request.headers),
                day=normalize_day(None),
                country=resolved_country,
            )
    payload = await dc.check_domains(raw_parts)
    if warm != "1":
        checked = [
            str(row.get("domain") or "")
            for row in payload.get("results") or []
            if row.get("status") in ("available", "registered")
        ]
        _record_endings_async(resolved_country, checked)
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


@app.get("/.well-known/api-catalog", tags=["discovery"])
async def well_known_api_catalog(request: Request) -> JSONResponse:
    """RFC 9727 API catalog linkset for the OpenAPI document."""
    public = (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/")
    if not public:
        public = str(request.base_url).rstrip("/")
    return JSONResponse(
        api_catalog(base_url=public),
        media_type="application/linkset+json",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# Mount MCP last so FastAPI routes take precedence for exact paths above.
app.mount("/mcp", mcp_app)


def create_app() -> FastAPI:
    """Factory for tests / alternative runners."""
    return app
