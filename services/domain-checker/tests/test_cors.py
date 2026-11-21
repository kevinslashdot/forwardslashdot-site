"""Browser CORS for the marketing-site domain search."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

SITE = "https://www.forwardslashdot.com"


@pytest.mark.asyncio
async def test_api_domain_cors_preflight():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.options(
            "/api/domain",
            headers={
                "Origin": SITE,
                "Access-Control-Request-Method": "GET",
            },
        )
    assert res.status_code in (200, 204)
    assert res.headers.get("access-control-allow-origin") == SITE


@pytest.mark.asyncio
async def test_api_domain_cors_get_header(monkeypatch):
    async def fake_check(domains):
        return {
            "count": 1,
            "results": [{"domain": domains[0], "status": "available", "source": "test", "cached": False}],
            "batch_cap": 25,
        }

    class FakeChecker:
        batch_cap = 25

        async def check_domains(self, domains):
            return await fake_check(domains)

        async def aclose(self):
            return None

    app.state.checker = FakeChecker()
    import app.main as main_mod

    monkeypatch.setattr(main_mod, "checker", FakeChecker())

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get(
            "/api/domain",
            params={"q": "example-xyz.test"},
            headers={"Origin": SITE},
        )
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == SITE
