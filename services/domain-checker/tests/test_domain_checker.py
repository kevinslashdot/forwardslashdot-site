"""Mocked tests for domain availability (RDAP, cache, batch, API, affiliate)."""

from __future__ import annotations

import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient

from app.domain_checker import (
    AffiliateConfig,
    BoundedTTLCache,
    DomainChecker,
    IANA_DNS_BOOTSTRAP,
)
from app.llms import MCP_DISCOVERY, build_llms_txt


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BOOTSTRAP_BODY = {
    "services": [
        [["com"], ["https://rdap.verisign.com/com/v1"]],
        [["net"], ["https://rdap.verisign.com/net/v1"]],
    ]
}


def _affiliate() -> AffiliateConfig:
    return AffiliateConfig(
        base_url="https://www.namecheap.com/domains/registration/results/",
        param_name="aff",
        affiliate_id="TESTAFF",
    )


@pytest.fixture
async def checker():
    async with httpx.AsyncClient() as http:
        dc = DomainChecker(
            http_client=http,
            owns_client=False,
            cache=BoundedTTLCache(max_entries=32, ttl=600),
            affiliate=_affiliate(),
            batch_cap=25,
            concurrency=5,
            race_dns=False,  # keep RDAP-only path for mocked HTTP tests
        )
        yield dc


# ---------------------------------------------------------------------------
# Unit: RDAP 404 → available + affiliate
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_rdap_404_available_with_affiliate(checker: DomainChecker):
    respx.get(IANA_DNS_BOOTSTRAP).mock(return_value=httpx.Response(200, json=BOOTSTRAP_BODY))
    respx.get("https://rdap.verisign.com/com/v1/domain/free-domain-xyz.com").mock(
        return_value=httpx.Response(404, text="not found")
    )

    result = await checker.check_one("free-domain-xyz.com")
    assert result["status"] == "available"
    assert result["source"] == "rdap"
    assert result["cached"] is False
    assert "affiliate_url" in result
    assert "aff=TESTAFF" in result["affiliate_url"]
    assert "domain=free-domain-xyz.com" in result["affiliate_url"]
    assert result["link_type"] == "affiliate"
    assert "commission" in result["disclosure"].lower() or "affiliate" in result["disclosure"].lower()


@pytest.mark.asyncio
@respx.mock
async def test_rdap_200_registered_no_affiliate(checker: DomainChecker):
    respx.get(IANA_DNS_BOOTSTRAP).mock(return_value=httpx.Response(200, json=BOOTSTRAP_BODY))
    respx.get("https://rdap.verisign.com/com/v1/domain/google.com").mock(
        return_value=httpx.Response(200, json={"ldhName": "GOOGLE.COM", "objectClassName": "domain"})
    )

    result = await checker.check_one("google.com")
    assert result["status"] == "registered"
    assert result["source"] == "rdap"
    assert "affiliate_url" not in result
    assert "disclosure" not in result


@pytest.mark.asyncio
@respx.mock
async def test_affiliate_omitted_when_unset():
    respx.get(IANA_DNS_BOOTSTRAP).mock(return_value=httpx.Response(200, json=BOOTSTRAP_BODY))
    respx.get("https://rdap.verisign.com/com/v1/domain/free2.com").mock(
        return_value=httpx.Response(404)
    )
    async with httpx.AsyncClient() as http:
        dc = DomainChecker(http_client=http, owns_client=False, affiliate=None, race_dns=False)
        result = await dc.check_one("free2.com")
    assert result["status"] == "available"
    assert "affiliate_url" not in result


# ---------------------------------------------------------------------------
# Batch cap
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_batch_cap(checker: DomainChecker):
    respx.get(IANA_DNS_BOOTSTRAP).mock(return_value=httpx.Response(200, json=BOOTSTRAP_BODY))
    # Match any RDAP domain URL under verisign or rdap.org
    respx.get(url__regex=r"https://rdap\.verisign\.com/.*/domain/.*").mock(
        return_value=httpx.Response(404)
    )
    respx.get(url__regex=r"https://rdap\.org/domain/.*").mock(return_value=httpx.Response(404))

    names = [f"d{i}.com" for i in range(30)]
    payload = await checker.check_domains(names)
    assert payload["count"] == 25
    assert payload["truncated"] is True
    assert payload["requested"] == 30
    assert payload["batch_cap"] == 25


def test_parse_batch_cap(checker: DomainChecker):
    # sync helper — fixture is async but parse_batch is sync; use a fresh instance
    dc = DomainChecker(batch_cap=25, affiliate=None)
    parts = dc.parse_batch(",".join(f"x{i}.com" for i in range(40)))
    assert len(parts) == 25


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_cache_hit(checker: DomainChecker):
    respx.get(IANA_DNS_BOOTSTRAP).mock(return_value=httpx.Response(200, json=BOOTSTRAP_BODY))
    route = respx.get("https://rdap.verisign.com/com/v1/domain/cached.com").mock(
        return_value=httpx.Response(200, json={"ldhName": "CACHED.COM"})
    )

    first = await checker.check_one("cached.com")
    second = await checker.check_one("cached.com")
    assert first["cached"] is False
    assert second["cached"] is True
    assert second["status"] == "registered"
    assert route.call_count == 1


@pytest.mark.asyncio
async def test_bounded_cache_eviction():
    cache = BoundedTTLCache(max_entries=2, ttl=600)
    await cache.set("a", {"v": 1})
    await cache.set("b", {"v": 2})
    await cache.set("c", {"v": 3})
    assert await cache.get("a") is None
    assert (await cache.get("b"))["v"] == 2
    assert (await cache.get("c"))["v"] == 3


# ---------------------------------------------------------------------------
# Invalid input
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invalid_domain(checker: DomainChecker):
    result = await checker.check_one("not a domain!!!")
    assert result["status"] == "invalid"


# ---------------------------------------------------------------------------
# FastAPI routes
# ---------------------------------------------------------------------------


@pytest.fixture
async def api_client(monkeypatch):
    """ASGI test client with RDAP mocked and a live DomainChecker.

    Skips FastMCP's Streamable HTTP lifespan (anyio task-group + pytest-asyncio
    teardown conflict). Production uvicorn still runs the combined lifespan.
    """
    monkeypatch.setenv(
        "AFFILIATE_BASE_URL",
        "https://www.namecheap.com/domains/registration/results/",
    )
    monkeypatch.setenv("AFFILIATE_PARAM_NAME", "aff")
    monkeypatch.setenv("AFFILIATE_ID", "TESTAFF")

    from app import main as main_mod

    with respx.mock:
        respx.get(IANA_DNS_BOOTSTRAP).mock(
            return_value=httpx.Response(200, json=BOOTSTRAP_BODY)
        )
        respx.get(url__regex=r"https://rdap\.verisign\.com/.*/domain/free-api\.com").mock(
            return_value=httpx.Response(404)
        )
        respx.get(url__regex=r"https://rdap\.verisign\.com/.*/domain/taken-api\.com").mock(
            return_value=httpx.Response(200, json={"ldhName": "TAKEN-API.COM"})
        )
        respx.get(url__regex=r"https://rdap\.verisign\.com/.*/domain/n\d+\.com").mock(
            return_value=httpx.Response(404)
        )
        respx.get(url__regex=r"https://rdap\.org/domain/.*").mock(
            return_value=httpx.Response(404)
        )

        async with DomainChecker(affiliate=_affiliate(), race_dns=False) as dc:
            main_mod.checker = dc
            main_mod.app.state.checker = dc
            try:
                transport = ASGITransport(app=main_mod.app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    yield client
            finally:
                main_mod.checker = None
                if hasattr(main_mod.app.state, "checker"):
                    delattr(main_mod.app.state, "checker")


@pytest.mark.asyncio
async def test_health(api_client: AsyncClient):
    resp = await api_client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_api_domain_available_and_registered(api_client: AsyncClient):
    resp = await api_client.get("/api/domain", params={"q": "free-api.com,taken-api.com"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 2
    by_name = {r["domain"]: r for r in body["results"]}
    assert by_name["free-api.com"]["status"] == "available"
    assert "affiliate_url" in by_name["free-api.com"]
    assert by_name["taken-api.com"]["status"] == "registered"
    assert "affiliate_url" not in by_name["taken-api.com"]


@pytest.mark.asyncio
async def test_api_batch_cap(api_client: AsyncClient):
    q = ",".join(f"n{i}.com" for i in range(30))
    resp = await api_client.get("/api/domain", params={"q": q})
    assert resp.status_code == 200
    body = resp.json()
    assert body["count"] == 25
    assert body.get("truncated") is True


@pytest.mark.asyncio
async def test_llms_txt(api_client: AsyncClient):
    resp = await api_client.get("/llms.txt")
    assert resp.status_code == 200
    assert "check_domains" in resp.text
    assert "forwardslashdot" in resp.text.lower()


@pytest.mark.asyncio
async def test_well_known_mcp_json(api_client: AsyncClient):
    resp = await api_client.get("/.well-known/mcp.json")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == MCP_DISCOVERY["name"]
    assert data["endpoint"].endswith("/mcp")
    assert data["transport"] == "streamable-http"


@pytest.mark.asyncio
async def test_well_known_api_catalog(api_client: AsyncClient):
    resp = await api_client.get("/.well-known/api-catalog")
    assert resp.status_code == 200
    assert "linkset" in resp.headers.get("content-type", "") or resp.headers.get("content-type", "").startswith(
        "application/"
    )
    data = resp.json()
    href = data["linkset"][0]["item"][0]["href"]
    assert href.endswith("/openapi.json")


@pytest.mark.asyncio
async def test_openapi_json(api_client: AsyncClient):
    resp = await api_client.get("/openapi.json")
    assert resp.status_code == 200
    schema = resp.json()
    assert "/api/domain" in schema["paths"]
    assert "/health" in schema["paths"]
    assert "/.well-known/api-catalog" in schema["paths"]


# ---------------------------------------------------------------------------
# MCP tool (shared logic path, without full Streamable HTTP handshake)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@respx.mock
async def test_mcp_tool_check_domains(monkeypatch):
    monkeypatch.setenv("AFFILIATE_BASE_URL", "https://www.namecheap.com/domains/registration/results/")
    monkeypatch.setenv("AFFILIATE_PARAM_NAME", "aff")
    monkeypatch.setenv("AFFILIATE_ID", "TESTAFF")

    respx.get(IANA_DNS_BOOTSTRAP).mock(return_value=httpx.Response(200, json=BOOTSTRAP_BODY))
    respx.get("https://rdap.verisign.com/com/v1/domain/mcp-free.com").mock(
        return_value=httpx.Response(404)
    )

    from app import main as main_mod

    async with DomainChecker(
        http_client=httpx.AsyncClient(),
        affiliate=_affiliate(),
        owns_client=True,
        race_dns=False,
    ) as dc:
        main_mod.checker = dc
        try:
            # Invoke the underlying function (FastMCP wraps the callable).
            fn = check_domains_callable(main_mod)
            result = await fn(["mcp-free.com"])
            assert result["count"] == 1
            assert result["results"][0]["status"] == "available"
            assert "affiliate_url" in result["results"][0]
        finally:
            main_mod.checker = None


def check_domains_callable(main_mod):
    """Resolve the raw async function behind the FastMCP tool decorator."""
    tool_fn = main_mod.check_domains
    # FastMCP may wrap; prefer .fn / __wrapped__ / direct awaitable.
    for attr in ("fn", "__wrapped__", "handler"):
        inner = getattr(tool_fn, attr, None)
        if inner is not None and callable(inner):
            return inner
    return tool_fn


def test_llms_builder_content():
    text = build_llms_txt(base_url="https://api.example.com")
    assert "https://api.example.com/mcp" in text
    assert "check_domains" in text
