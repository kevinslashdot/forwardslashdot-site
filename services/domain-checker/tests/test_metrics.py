"""Tests for request metrics (HTTP + MCP counts, file persistence, /stats)."""

from __future__ import annotations

import json
import os
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
    m = RequestMetrics(path=path, database_url=None)
    m.record("http", domain_count=2, area="instant_domain_search", country="US")
    m.record("mcp", domain_count=1, area="other", country="XX")
    m.record_hit("world_time_converter", country="DE")
    snap = m.snapshot()
    assert snap["total_checks"] == 2
    assert snap["by_source"]["http"] == 1
    assert snap["by_source"]["mcp"] == 1
    assert snap["domains_checked"] == 3
    assert snap["by_area"]["instant_domain_search"]["checks"] == 1
    assert snap["by_area"]["instant_domain_search"]["domains_checked"] == 2
    assert snap["by_area"]["world_time_converter"]["hits"] == 1
    assert snap["by_country"]["US"]["checks"] == 1
    assert snap["by_country"]["US"]["domains_checked"] == 2
    assert snap["by_country"]["DE"]["hits"] == 1
    assert snap["last_24h"]["checks"] == 2
    assert snap["last_24h"]["by_area"]["world_time_converter"]["hits"] == 1
    assert snap["last_24h"]["by_country"]["DE"]["hits"] == 1
    assert snap["persistence"] == "file"
    assert path.is_file()

    # Reload from disk
    m2 = RequestMetrics(path=path, database_url=None)
    snap2 = m2.snapshot()
    assert snap2["total_checks"] == 2
    assert snap2["by_source"]["http"] == 1
    assert snap2["domains_checked"] == 3
    assert snap2["by_area"]["world_time_converter"]["hits"] == 1
    assert snap2["by_country"]["US"]["checks"] == 1


def test_audience_counts_a_device_once_per_day(tmp_path: Path):
    from datetime import datetime, timedelta, timezone

    today = datetime.now(timezone.utc).date()
    yesterday = (today - timedelta(days=1)).isoformat()
    m = RequestMetrics(path=tmp_path / "audience.json", database_url=None)
    assert m.record_audience(
        "world_time_converter", actor="human", visitor="device-one", day=yesterday, country="CA"
    )
    assert not m.record_audience(
        "world_time_converter", actor="human", visitor="device-one", day=yesterday, country="CA"
    )
    assert m.record_audience(
        "world_time_converter", actor="human", visitor="device-one", day=today.isoformat(), country="CA"
    )
    assert m.record_audience(
        "instant_domain_search", actor="llm", visitor="modelhash01", day=today.isoformat(), country="US"
    )
    assert not m.record_audience(
        "instant_domain_search", actor="llm", visitor="modelhash01", day=today.isoformat(), country="US"
    )
    snap = m.snapshot()
    time_area = snap["by_area"]["world_time_converter"]
    domain_area = snap["by_area"]["instant_domain_search"]
    assert time_area["human"] == 2
    assert time_area["llm"] == 0
    assert time_area["hits"] == 2
    assert domain_area["llm"] == 1
    assert domain_area["human"] == 0
    blob = json.dumps(snap)
    assert "device-one" not in blob
    assert "modelhash01" not in blob

    reloaded = RequestMetrics(path=tmp_path / "audience.json", database_url=None)
    assert not reloaded.record_audience(
        "world_time_converter", actor="human", visitor="device-one", day=today.isoformat(), country="CA"
    )


def test_normalize_area_aliases():
    from app.metrics import normalize_area

    assert normalize_area("InstantDomainSearch") == "instant_domain_search"
    assert normalize_area("world-time-converter") == "world_time_converter"
    assert normalize_area("nope") == "other"


def test_normalize_country_and_headers():
    from app.metrics import country_from_headers, normalize_country

    assert normalize_country("us") == "US"
    assert normalize_country("T1") == "T1"
    assert normalize_country("xx") == "XX"
    assert normalize_country("1.2.3.4") == "XX"
    assert normalize_country("United States") == "XX"
    assert normalize_country(None) == "XX"
    assert country_from_headers({"CF-IPCountry": "CA"}) == "CA"
    assert country_from_headers({"cf-ipcountry": "gb"}) == "GB"
    assert country_from_headers({"X-Forwarded-For": "1.2.3.4"}) == "XX"
    assert country_from_headers({"CF-Connecting-IP": "8.8.8.8"}) == "XX"
    assert country_from_headers({}) == "XX"


def test_metrics_snapshot_has_no_domain_names(tmp_path: Path):
    path = tmp_path / "m.json"
    m = RequestMetrics(path=path, database_url=None)
    m.record("http", domain_count=1, country="US")
    blob = json.dumps(m.snapshot())
    assert "example.com" not in blob
    assert "q=" not in blob
    assert "1.2.3.4" not in blob
    assert '"US"' in blob


@pytest.fixture
async def api_client_metrics(tmp_path: Path, monkeypatch):
    metrics_path = tmp_path / "api-metrics.json"
    reset_metrics(path=metrics_path, database_url=None)

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

        async with DomainChecker(affiliate=None, race_dns=False) as dc:
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

    resp = await api_client_metrics.get(
        "/api/domain",
        params={"q": "a.com,b.com", "area": "instant_domain_search"},
        headers={"CF-IPCountry": "US"},
    )
    assert resp.status_code == 200

    hit = await api_client_metrics.get(
        "/api/hit",
        params={"area": "world_time_converter"},
        headers={"CF-IPCountry": "JP"},
    )
    assert hit.status_code == 200
    assert hit.json()["area"] == "world_time_converter"
    assert hit.json()["country"] == "JP"

    # Give daemon metric threads a moment (non-blocking writes).
    import time as _time

    for _ in range(40):
        stats = (await api_client_metrics.get("/stats")).json()
        if stats.get("total_checks", 0) >= 1 and stats.get("by_country", {}).get("JP"):
            break
        _time.sleep(0.05)

    stats = (await api_client_metrics.get("/stats")).json()
    assert stats["total_checks"] == 1
    assert stats["by_source"]["http"] == 1
    assert stats["by_source"]["mcp"] == 0
    assert stats["domains_checked"] == 2
    assert stats["last_24h"]["http"] == 1
    assert stats["by_area"]["instant_domain_search"]["checks"] == 1
    assert stats["by_area"]["world_time_converter"]["hits"] == 1
    assert stats["by_country"]["US"]["checks"] == 1
    assert stats["by_country"]["JP"]["hits"] == 1
    assert stats["last_24h"]["by_country"]["US"]["checks"] == 1
    paths = (await api_client_metrics.get("/openapi.json")).json()["paths"]
    assert "/stats" in paths
    assert "/api/hit" in paths

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setenv("STATS_PASSWORD", "secret-stats")
    try:
        locked = await api_client_metrics.get("/stats")
        assert locked.status_code == 401
        opened = await api_client_metrics.get("/stats", headers={"Authorization": "Bearer secret-stats"})
        assert opened.status_code == 200
        assert opened.json()["total_checks"] == 1
    finally:
        monkeypatch.undo()

    day = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).date().isoformat()
    first = await api_client_metrics.get(
        "/api/hit",
        params={"area": "instant_domain_search", "actor": "human", "visitor": "browser-1", "day": day},
        headers={"CF-IPCountry": "CA"},
    )
    second = await api_client_metrics.get(
        "/api/hit",
        params={"area": "instant_domain_search", "actor": "human", "visitor": "browser-1", "day": day},
        headers={"CF-IPCountry": "CA"},
    )
    assert first.json()["recorded"] is True
    assert second.json()["recorded"] is False
    deduped = (await api_client_metrics.get("/stats")).json()
    assert deduped["by_area"]["instant_domain_search"]["human"] == 1


@pytest.mark.asyncio
async def test_mcp_tool_increments_mcp_count(tmp_path: Path, monkeypatch):
    reset_metrics(path=tmp_path / "mcp-metrics.json", database_url=None)
    from app import main as main_mod
    import app.metrics as metrics_mod

    main_mod.metrics = metrics_mod.metrics

    with respx.mock:
        respx.get(IANA_DNS_BOOTSTRAP).mock(
            return_value=httpx.Response(200, json=BOOTSTRAP_BODY)
        )
        respx.get("https://rdap.verisign.com/com/v1/domain/mcp-count.com").mock(
            return_value=httpx.Response(404)
        )

        async with DomainChecker(affiliate=None, race_dns=False) as dc:
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


def _postgres_url_available() -> bool:
    if os.getenv("DATABASE_URL") or os.getenv("NEON_DATABASE_URL"):
        return True
    return Path("/agent/secrets-scratch/database_url").is_file()


@pytest.mark.skipif(not _postgres_url_available(), reason="No Postgres URL for integration test")
def test_metrics_postgres_roundtrip(tmp_path: Path):
    url = os.getenv("DATABASE_URL") or os.getenv("NEON_DATABASE_URL")
    if not url and Path("/agent/secrets-scratch/database_url").is_file():
        url = Path("/agent/secrets-scratch/database_url").read_text().strip()
    assert url
    # Unique schema so parallel/local runs do not collide with prod counters.
    os.environ["METRICS_PG_SCHEMA"] = "domain_checker_test"
    try:
        m = RequestMetrics(path=tmp_path / "ignored.json", database_url=url)
        assert m.persistence == "postgres"
        before = m.snapshot()["total_checks"]
        m.record("http", domain_count=2)
        snap = m.snapshot()
        assert snap["persistence"] == "postgres"
        assert snap["total_checks"] == before + 1
        assert snap["by_source"]["http"] >= 1
        m2 = RequestMetrics(path=tmp_path / "ignored2.json", database_url=url)
        assert m2.snapshot()["total_checks"] == snap["total_checks"]
    finally:
        os.environ.pop("METRICS_PG_SCHEMA", None)
        try:
            import psycopg

            with psycopg.connect(url, connect_timeout=10) as conn:
                conn.execute("DROP SCHEMA IF EXISTS domain_checker_test CASCADE")
                conn.commit()
        except Exception:
            pass


def test_llms_mentions_stats():
    from app.llms import build_llms_txt

    text = build_llms_txt(base_url="https://api.example.com")
    assert "https://api.example.com/stats" in text
