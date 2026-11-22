# Domain checker (FastAPI + FastMCP)

Production-ready domain availability service for **[forwardslashdot.com](https://forwardslashdot.com)**.

Lives under `services/domain-checker/` so the Cloudflare Pages deploy of the repo-root static `index.html` is unaffected.

## What you get

| Surface | Path | Notes |
|--------|------|--------|
| Health | `GET /health` | Liveness |
| Stats | `GET /stats` | Aggregate check/hit counts by transport + site area; no query logs |
| Hit | `GET /api/hit?area=` | Attribute a non-PII utility hit (e.g. `world_time_converter`) |
| Domain | `GET /api/domain?q=&area=` | Optional `area` for stats attribution |
| REST | `GET /api/domain?q=` | Comma-separated batch, capped (~25) |
| MCP | `/mcp` | FastMCP Streamable HTTP; tool `check_domains` |
| OpenAPI | `/openapi.json` | FastAPI schema |
| API catalog | `/.well-known/api-catalog` | RFC 9727 linkset → OpenAPI |
| llms.txt | `/llms.txt` | [llmstxt.org](https://llmstxt.org/) |
| Discovery | `/.well-known/mcp.json` | MCP endpoint metadata |

Shared logic lives in `app/domain_checker.py` (used by both REST and MCP).

### Lookup strategy

1. **RDAP** via IANA `dns.json` bootstrap (fallback `rdap.org`)
   - HTTP **404** → `available`
   - HTTP **200** → `registered`
2. **DNS** NS / SOA fallback when RDAP is inconclusive
3. In-memory cache (~10 minute TTL, bounded size)
4. `asyncio.Semaphore` limits concurrent upstream calls

## Layout

```
services/domain-checker/
  app/
    main.py              # FastAPI + FastMCP mount (/mcp) + lifespan
    domain_checker.py    # RDAP/DNS/cache/affiliate
    llms.py              # llms.txt + mcp.json helpers
  tests/
    test_domain_checker.py
  Dockerfile
  pyproject.toml
  requirements.txt
  README.md
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Listen port (default `8000`) |
| `PUBLIC_BASE_URL` | No | Absolute public origin for `/llms.txt` and `/.well-known/mcp.json` links |
| `DATABASE_URL` / `NEON_DATABASE_URL` | No | Postgres (Neon) for durable `/stats` aggregates; uses schema `domain_checker` |
| `METRICS_PG_SCHEMA` | No | Override Postgres schema (default `domain_checker`) |
| `METRICS_PATH` | No | JSON file fallback when DB unset (default `/data/metrics.json` in Docker, else `/tmp/…`) |
| `AFFILIATE_BASE_URL` | No | Registrar search/register base URL |
| `AFFILIATE_PARAM_NAME` | No | Query param name for the affiliate id |
| `AFFILIATE_ID` | No | Affiliate / referral id |

If any of the three `AFFILIATE_*` values is missing, affiliate fields are **omitted** from responses.

Referral env is intentionally blank for now. Namecheap-style example (comments / local `.env` only — do not commit real IDs):

```bash
# AFFILIATE_BASE_URL=https://www.namecheap.com/domains/registration/results/
# AFFILIATE_PARAM_NAME=aff
# AFFILIATE_ID=YOUR_AFFILIATE_ID
```

Available domains then include `affiliate_url`, `link_type`, and a short `disclosure`.

## Local run

```bash
cd services/domain-checker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### curl

```bash
curl -s http://127.0.0.1:8000/health | jq .

curl -s 'http://127.0.0.1:8000/api/domain?q=example.com,google.com' | jq .

curl -s http://127.0.0.1:8000/llms.txt
curl -s http://127.0.0.1:8000/.well-known/mcp.json | jq .
curl -s http://127.0.0.1:8000/openapi.json | jq '.paths | keys'
```

### MCP usage

Point an MCP client (Cursor, Claude, etc.) at Streamable HTTP:

```text
http://127.0.0.1:8000/mcp
```

Tool: **`check_domains`** — pass a list of domains (or a comma-separated string). Batch is capped (~25).

Example Cursor MCP config snippet:

```json
{
  "mcpServers": {
    "forwardslashdot-domains": {
      "url": "http://127.0.0.1:8000/mcp"
    }
  }
}
```

## Public URL

Production origin: **https://api.forwardslashdot.com**

Discovery for LLMs: `/llms.txt`, `/.well-known/mcp.json`, `/openapi.json`, MCP at `/mcp`.

## Docker / Coolify / Fly / Tunnel

```bash
cd services/domain-checker
docker build -t forwardslashdot-domain-checker .
docker run --rm -p 8000:8000 \
  -e PUBLIC_BASE_URL=https://api.forwardslashdot.com \
  forwardslashdot-domain-checker
```

**Cloudflare Tunnel (current public path):** named tunnel fronts `api.forwardslashdot.com` → local `:8000`. Connector must stay running (`cloudflared tunnel run --token …`). Token lives in Cloudflare Zero Trust → Networks → Tunnels (never commit it).

**Fly.io (durable alternative):** `fly.toml` in this directory + `.github/workflows/fly-domain-checker.yml`. Needs repo secret `FLY_API_TOKEN`. After first `fly apps create` / deploy, point DNS `api` CNAME at the Fly app hostname (or keep the Tunnel and change ingress to the Fly URL).

**Coolify:** create an application from this subdirectory, Dockerfile build, expose port `8000` (or set `PORT`). Attach a domain / reverse proxy; set `PUBLIC_BASE_URL=https://api.forwardslashdot.com`. Leave `AFFILIATE_*` empty until you have a referral program.

## Tests

```bash
cd services/domain-checker
pip install -r requirements.txt
pytest -q
```

Tests mock RDAP (404 available + affiliate, 200 registered), batch cap, cache, REST discovery routes, and the MCP tool’s shared logic path.

## Future utilities (not implemented)

See comments in `app/domain_checker.py`: WHOIS fallback, premium-name hints, Redis cache for multi-instance deploys, per-client rate limits.
