"""llms.txt (https://llmstxt.org/) content for this service.

Describes what the domain-checker exposes so LLM clients can discover
capabilities without scraping OpenAPI alone.
"""

from __future__ import annotations

SERVICE_NAME = "forwardslashdot domain checker"
SERVICE_HOME = "https://forwardslashdot.com"


def build_llms_txt(*, base_url: str = "") -> str:
    """Return plain-text llms.txt body.

    base_url is optional; when empty, relative paths are documented so the
    same text works behind any Coolify / reverse-proxy host.
    """
    root = base_url.rstrip("/") if base_url else ""

    def u(path: str) -> str:
        return f"{root}{path}" if root else path

    return f"""# {SERVICE_NAME}

> Domain availability checks for {SERVICE_HOME}, exposed as a REST API and an MCP (Model Context Protocol) server over Streamable HTTP.

This service is part of the forwardslashdot.com project. The marketing site remains a static Cloudflare Pages root; this Python service runs separately (e.g. Coolify).

## Endpoints

- [Health]({u("/health")}): Liveness probe — JSON `{{"status":"ok"}}`.
- [Stats]({u("/stats")}): Aggregate counts by site area. Password-protected when STATS_PASSWORD is set (`Authorization: Bearer`). No query logs or PII.
- [Hit]({u("/api/hit")}): `GET /api/hit?area=&actor=human|llm&visitor=&day=` — one non-PII visit. The same visitor counts once per calendar day.
- [Domain API]({u("/api/domain")}): `GET /api/domain?q=&area=` — one or more full domains, any public ending (`.com`, `.si`, `.biz`, `.ai`, `.io`, `.co.uk`), comma-separated, batch capped (~25). Optional `area` for stats. Shared logic with the MCP tool.
- [Endings]({u("/api/endings")}): `GET /api/endings` — six endings for the visitor’s country, limited to endings Namecheap sells (Canada `.ca`, Australia `.com.au`). Moves as checks from that country accumulate. Country and ending only; the names people type are not stored.
- [TLD catalog]({u("/api/tlds")}): `GET /api/tlds` — every ending Namecheap sells. Refreshed nightly, and rewritten only when the set changes.
- [OpenAPI]({u("/openapi.json")}): Machine-readable HTTP API schema.
- [API catalog]({u("/.well-known/api-catalog")}): RFC 9727 linkset pointing at OpenAPI.
- [MCP]({u("/mcp")}): FastMCP Streamable HTTP endpoint. Tool: `check_domains`.
- [MCP discovery]({u("/.well-known/mcp.json")}): Server name, description, and MCP endpoint URL.
- [llms.txt]({u("/llms.txt")}): This file.

## MCP tool: check_domains

Accepts a list (or comma-separated string) of full domain names. Any public ending works: `.com`, `.si`, `.biz`, `.ai`, `.io`, `.co.uk`, and the rest. Returns availability using RDAP first (IANA dns.json bootstrap / rdap.org), with DNS NS/SOA fallback. Optional affiliate/referral fields appear only when `AFFILIATE_*` env vars are set.

## Notes

- Results are cached in-memory (~10 minute TTL, bounded size).
- Affiliate/referral links are omitted unless configured; see service README.
- Do not treat availability as a guarantee of registrability (premium/reserved names, registry policy).
"""


MCP_DISCOVERY = {
    "name": "forwardslashdot domain checker",
    "description": (
        "Check any public domain ending via RDAP (with DNS fallback). "
        "Pass full names such as studio.si or cafe.biz to check_domains. "
        "Brand: forwardslashdot.com."
    ),
    "endpoint": "/mcp",
}


def api_catalog(*, base_url: str) -> dict:
    """RFC 9727 API catalog linkset for the OpenAPI document."""
    root = base_url.rstrip("/")
    return {
        "linkset": [
            {
                "anchor": f"{root}/",
                "item": [
                    {
                        "href": f"{root}/openapi.json",
                        "type": "application/openapi+json",
                    }
                ],
            }
        ]
    }
