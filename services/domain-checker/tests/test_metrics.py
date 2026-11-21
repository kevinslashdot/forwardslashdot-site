"""Tests for request metrics (HTTP + MCP counts, file persistence, /stats)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx
from httpx import ASGITransport, AsyncClient

from app.domain_checker import DomainChecker, IANA_DNS_BOOTSTRAP
from app.metrics import RequestMetrics, reset_metrics

BOOTSTRAP_BODY = {
    "services": [
        [["com"], ["https://rdap.verisign.com/com/v1"]],
    ]
}


def test_metrics_record_and_persist(tmp_path: Path):
    path = tmp_path / "metrics.json"
    m = RequestMetrics(path=path)
    m.record("http", domain_count=2)
    m.record("mcp", domain_count=1)
    snap = m.snapshot()
    assert snap["total_checks"] == 2
    assert snap["by_source"]["http"] == 1
    assert snap["by_source"]["mcp"] == 1
    assert snap["domains_checked"] == 3
    assert snap["last_24h"]["checks"] == 2
    assert snap["persistence"] == "file"
    assert path.is_file()

    # Reload from disk
    m2 = RequestMetrics(path=path)
    snap2 = m2.snapshot()
    assert snap2["total_checks"] == 2
    assert snap2["by_source"]["http"] == 1
    assert snap2["domains_checked"] == 3


def test_metrics_snapshot_has_no_domain_names(tmp_path: Path):
    path = tmp_path / "m.json"
    m = RequestMetrics(path=path)
    m.record("http", domain_count=1)
    blob = json.dumps(m.snapshot())
    assert "example.com" not in blob
    assert "q=" not in blob


@pytest.fixture
async def api_client_metrics(tmp_path: Path, monkeypatch):
    metrics_path = tmp_path / "api-metrics.json"
    reset_metrics(path=metrics_path)

    from app import main as main_mod
    import app.metrics as metrics_mod

    monkeypatch.setenv("AFFILIATE_BASE_URL", "")
    monkeypatch.setenv("AFFILIATE_PARAM_NAME", "")
    monkeypatch.setenv("AFFILIATE_ID", "")

    with respx.mock:
        respx.get(IANA_DNS_BOOTSTRAP).mock(
            return_value=httpx.Response(200, json=BOOTSTRAP_BODY)
        )
        respx.get(url__regex=r"https://rdap\.verisign\.com/.*/domain/.*").mock(
            return_value=httpx.Response(404)
        )

        async with DomainChecker(affiliate=None) as dc:
            main_mod.checker = dc
            main_mod.app.state.checker = dc
            # Keep main.metrics in sync with module singleton after reset.
            main_mod.metrics = metrics_mod.metrics
            try:
                transport = ASGITransport(app=main_mod.app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    yield client
            finally:
                main_mod.checker = None
                if hasattr(main_mod.app.state, "checker"):
                    delattr(main_mod.app.state, "checker")


@pytest.mark.asyncio
async def test_stats_and_http_counting(api_client_metrics: AsyncClient):
    # Health / discovery must not inflate check counts
    assert (await api_client_metrics.get("/health")).status_code == 200
    assert (await api_client_metrics.get("/llms.txt")).status_code == 200
    assert (await api_client_metrics.get("/.well-known/mcp.json")).status_code == 200
    assert (await api_client_metrics.get("/stats")).status_code == 200
    before = (await api_client_metrics.get("/stats")).json()
    assert before["total_checks"] == 0

    resp = await api_client_metrics.get("/api/domain", params={"q": "a.com,b.com"})
    assert resp.status_code == 200

    stats = (await api_client_metrics.get("/stats")).json()
    assert stats["total_checks"] == 1
    assert stats["by_source"]["http"] == 1
    assert stats["by_source"]["mcp"] == 0
    assert stats["domains_checked"] == 2
    assert stats["last_24h"]["http"] == 1
    assert "/stats" in (await api_client_metrics.get("/openapi.json")).json()["paths"]


@pytest.mark.asyncio
async def test_mcp_tool_increments_mcp_count(tmp_path: Path, monkeypatch):
    reset_metrics(path=tmp_path / "mcp-metrics.json")
    from app import main as main_mod
    import app.metrics as metrics_mod

    main_mod.metrics = metrics_mod.metrics

    respx.get(IANA_DNS_BOOTSTRAP).mock(return_value=httpx.Response(200, json=BOOTSTRAP_BODY))
    respx.get("https://rdap.verisign.com/com/v1/domain/mcp-count.com").mock(
        return_value=httpx.Response(404)
    )

    with respx.mock:
        respx.get(IANA_DNS_BOOTSTRAP).mock(
            return_value=httpx.Response(200, json=BOOTSTRAP_BODY)
        )
        respx.get("https://rdap.verisign.com/com/v1/domain/mcp-count.com").mock(
            return_value=httpx.Response(404)
        )

        async with DomainChecker(affiliate=None) as dc:
            main_mod.checker = dc
            try:
                tool_fn = main_mod.check_domains
                fn = tool_fn
                for attr in ("fn", "__wrapped__", "handler"):
                    inner = getattr(tool_fn, attr, None)
                    if inner is not None and callable(inner):
                        fn = inner
                        break
                result = await fn(["mcp-count.com"])
                assert result["count"] == 1
            finally:
                main_mod.checker = None

    snap = metrics_mod.metrics.snapshot()
    assert snap["total_checks"] == 1
    assert snap["by_source"]["mcp"] == 1
    assert snap["domains_checked"] == 1


def test_llms_mentions_stats():
    from app.llms import build_llms_txt

    text = build_llms_txt(base_url="https://api.example.com")
    assert "https://api.example.com/stats" in text
