"""Shared domain-availability logic for the REST API and MCP tool.

RDAP-first (IANA dns.json bootstrap, with rdap.org as fallback), then DNS
NS/SOA probes when RDAP is inconclusive. Results are cached in-process with
a bounded TTL cache.

Affiliate / referral links (optional):
  Set AFFILIATE_BASE_URL, AFFILIATE_PARAM_NAME, and AFFILIATE_ID to append a
  registrar deep-link when a domain looks available. Leave them unset to omit
  affiliate fields entirely.

  Namecheap-style example (do not commit real affiliate IDs):
    AFFILIATE_BASE_URL=https://www.namecheap.com/domains/registration/results/
    AFFILIATE_PARAM_NAME=aff
    AFFILIATE_ID=YOUR_AFFILIATE_ID
  Resulting URL shape:
    https://www.namecheap.com/domains/registration/results/?domain=example.com&aff=YOUR_AFFILIATE_ID

Future utilities (comments only — not implemented yet):
  - WHOIS fallback for TLDs without RDAP
  - Premium / reserved-name hints from registrar APIs
  - Rate-limit headers / per-client quotas
  - Persistent cache (Redis) for multi-instance Coolify deploys
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlencode

import dns.asyncresolver
import dns.rdatatype
import dns.resolver
import httpx

Status = Literal["available", "registered", "unknown", "invalid", "error"]

IANA_DNS_BOOTSTRAP = "https://data.iana.org/rdap/dns.json"
RDAP_ORG_FALLBACK = "https://rdap.org/domain/{domain}"

# Seed common TLDs so the first browser keystroke does not wait on IANA dns.json.
# Values match https://data.iana.org/rdap/dns.json (trailing slashes stripped at use).
KNOWN_RDAP_BASES: dict[str, list[str]] = {
    "com": ["https://rdap.verisign.com/com/v1"],
    "net": ["https://rdap.verisign.com/net/v1"],
    "org": ["https://rdap.publicinterestregistry.org/rdap"],
    "app": ["https://pubapi.registry.google/rdap"],
    "dev": ["https://pubapi.registry.google/rdap"],
    "ai": ["https://rdap.identitydigital.services/rdap"],
    "xyz": ["https://rdap.centralnic.com/xyz"],
    # io / co often absent from IANA bootstrap → rdap.org only until refreshed.
}

DEFAULT_CACHE_TTL_SECONDS = 600  # ~10 minutes
DEFAULT_CACHE_MAX_ENTRIES = 2048
DEFAULT_CONCURRENCY = 10
DEFAULT_BATCH_CAP = 25
HTTP_TIMEOUT = 4.0
DNS_LIFETIME = 2.0

# Basic FQDN shape: labels of alnum/hyphen, at least one dot, TLD letters.
_DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class AffiliateConfig:
    """Optional registrar referral settings from the environment."""

    base_url: str
    param_name: str
    affiliate_id: str
    disclosure: str = (
        "Affiliate disclosure: forwardslashdot.com may earn a commission "
        "if you register a domain through this link."
    )
    link_type: str = "affiliate"

    @classmethod
    def from_env(cls) -> AffiliateConfig | None:
        base = (os.getenv("AFFILIATE_BASE_URL") or "").strip()
        param = (os.getenv("AFFILIATE_PARAM_NAME") or "").strip()
        aff_id = (os.getenv("AFFILIATE_ID") or "").strip()
        if not (base and param and aff_id):
            return None
        return cls(base_url=base, param_name=param, affiliate_id=aff_id)

    def build_url(self, domain: str) -> str:
        # Preserve any existing query on the base URL; always add domain + aff.
        sep = "&" if "?" in self.base_url else "?"
        query = urlencode({"domain": domain, self.param_name: self.affiliate_id})
        if self.base_url.endswith(("?", "&")):
            return f"{self.base_url}{query}"
        return f"{self.base_url}{sep}{query}"


@dataclass
class _CacheEntry:
    value: dict[str, Any]
    expires_at: float


class BoundedTTLCache:
    """Simple in-memory LRU + TTL cache (process-local)."""

    def __init__(self, max_entries: int = DEFAULT_CACHE_MAX_ENTRIES, ttl: float = DEFAULT_CACHE_TTL_SECONDS):
        self._max = max(1, max_entries)
        self._ttl = ttl
        self._data: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, key: str) -> dict[str, Any] | None:
        async with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            if entry.expires_at < time.monotonic():
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            # Return a shallow copy so callers cannot mutate the cache.
            return dict(entry.value)

    async def set(self, key: str, value: dict[str, Any]) -> None:
        async with self._lock:
            if key in self._data:
                self._data.move_to_end(key)
            self._data[key] = _CacheEntry(value=dict(value), expires_at=time.monotonic() + self._ttl)
            while len(self._data) > self._max:
                self._data.popitem(last=False)

    async def clear(self) -> None:
        async with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        return len(self._data)


class DomainChecker:
    """RDAP + DNS domain availability checker with cache and concurrency limits."""

    def __init__(
        self,
        *,
        http_client: httpx.AsyncClient | None = None,
        cache: BoundedTTLCache | None = None,
        affiliate: AffiliateConfig | None = None,
        concurrency: int = DEFAULT_CONCURRENCY,
        batch_cap: int = DEFAULT_BATCH_CAP,
        owns_client: bool | None = None,
        race_dns: bool = True,
    ) -> None:
        self._client = http_client or httpx.AsyncClient(
            timeout=HTTP_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": "forwardslashdot-domain-checker/1.0 (+https://forwardslashdot.com)"},
        )
        self._owns_client = self._client is not http_client if owns_client is None else owns_client
        self.cache = cache or BoundedTTLCache()
        self.affiliate = affiliate if affiliate is not None else AffiliateConfig.from_env()
        self.batch_cap = batch_cap
        self.race_dns = race_dns
        self._sem = asyncio.Semaphore(concurrency)
        # Start with known TLD bases; IANA bootstrap merges in the background.
        self._bootstrap: dict[str, list[str]] = {
            k: list(v) for k, v in KNOWN_RDAP_BASES.items()
        }
        self._bootstrap_ready = False
        self._bootstrap_lock = asyncio.Lock()
        self._bootstrap_task: asyncio.Task[None] | None = None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> DomainChecker:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    def normalize_domain(self, raw: str) -> str | None:
        domain = raw.strip().lower().rstrip(".")
        if domain.startswith("http://") or domain.startswith("https://"):
            # Strip scheme/path if a full URL was pasted.
            domain = domain.split("://", 1)[1].split("/", 1)[0]
        if "@" in domain:
            return None
        if not _DOMAIN_RE.match(domain):
            return None
        return domain

    def parse_batch(self, q: str) -> list[str]:
        """Split a comma-separated query string and apply the batch cap."""
        parts = [p.strip() for p in q.split(",") if p.strip()]
        return parts[: self.batch_cap]

    async def check_domains(self, domains: list[str]) -> dict[str, Any]:
        """Check up to batch_cap domains; shared by REST and MCP."""
        capped = domains[: self.batch_cap]
        truncated = len(domains) > self.batch_cap
        results = await asyncio.gather(*(self.check_one(d) for d in capped))
        payload: dict[str, Any] = {
            "count": len(results),
            "results": results,
            "batch_cap": self.batch_cap,
        }
        if truncated:
            payload["truncated"] = True
            payload["requested"] = len(domains)
        return payload

    async def check_one(self, raw: str) -> dict[str, Any]:
        domain = self.normalize_domain(raw)
        if domain is None:
            return {
                "domain": raw.strip(),
                "status": "invalid",
                "source": None,
                "cached": False,
            }

        cached = await self.cache.get(domain)
        if cached is not None:
            out = dict(cached)
            out["cached"] = True
            return out

        async with self._sem:
            result = await self._lookup(domain)

        await self.cache.set(domain, result)
        out = dict(result)
        out["cached"] = False
        return out

    async def _lookup(self, domain: str) -> dict[str, Any]:
        """RDAP-first, optionally racing DNS for the first definitive answer."""
        if not self.race_dns:
            rdap = await self._rdap_lookup(domain)
            if rdap["status"] in ("available", "registered"):
                return self._with_affiliate(rdap)
            dns_result = await self._dns_fallback(domain)
            if dns_result["status"] in ("available", "registered"):
                return self._with_affiliate(dns_result)
            merged = dict(rdap)
            if dns_result.get("detail"):
                merged["detail"] = (
                    f"{merged.get('detail') or ''}; dns: {dns_result['detail']}"
                ).strip("; ")
            merged["source"] = merged.get("source") or "dns"
            return self._with_affiliate(merged)

        rdap_task = asyncio.create_task(self._rdap_lookup(domain))
        dns_task = asyncio.create_task(self._dns_fallback(domain))
        pending: set[asyncio.Task[dict[str, Any]]] = {rdap_task, dns_task}
        rdap: dict[str, Any] | None = None
        dns_result: dict[str, Any] | None = None
        try:
            while pending:
                done, pending = await asyncio.wait(
                    pending, return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    result = task.result()
                    if task is rdap_task:
                        rdap = result
                    else:
                        dns_result = result
                    if result.get("status") in ("available", "registered"):
                        for other in pending:
                            other.cancel()
                        return self._with_affiliate(result)
        finally:
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

        # Both inconclusive — prefer RDAP detail, fall back to DNS.
        merged = dict(rdap or dns_result or {"domain": domain, "status": "unknown", "source": None})
        if rdap and dns_result and dns_result.get("detail"):
            merged["detail"] = (
                f"{merged.get('detail') or ''}; dns: {dns_result['detail']}"
            ).strip("; ")
        if not merged.get("source"):
            merged["source"] = (dns_result or {}).get("source") or "rdap"
        return self._with_affiliate(merged)

    def _with_affiliate(self, result: dict[str, Any]) -> dict[str, Any]:
        out = dict(result)
        if out.get("status") == "available" and self.affiliate is not None:
            out["affiliate_url"] = self.affiliate.build_url(out["domain"])
            out["link_type"] = self.affiliate.link_type
            out["disclosure"] = self.affiliate.disclosure
        return out

    def kick_bootstrap_refresh(self) -> None:
        """Schedule a non-blocking IANA bootstrap refresh (call from lifespan)."""
        if self._bootstrap_ready or (
            self._bootstrap_task is not None and not self._bootstrap_task.done()
        ):
            return
        self._bootstrap_task = asyncio.create_task(self._refresh_bootstrap())

    async def _refresh_bootstrap(self) -> None:
        async with self._bootstrap_lock:
            try:
                resp = await self._client.get(IANA_DNS_BOOTSTRAP)
                resp.raise_for_status()
                data = resp.json()
                mapping: dict[str, list[str]] = {
                    k: list(v) for k, v in KNOWN_RDAP_BASES.items()
                }
                for tld, urls in data.get("services", []):
                    # IANA format: services is list of [ [tld,...], [url,...] ]
                    if not isinstance(tld, list) or not isinstance(urls, list):
                        continue
                    for label in tld:
                        mapping[str(label).lower()] = [str(u).rstrip("/") for u in urls]
                self._bootstrap = mapping
                self._bootstrap_ready = True
            except Exception:
                # Keep seeded map; callers still have rdap.org fallback.
                self._bootstrap_ready = False

    async def _ensure_bootstrap(self) -> dict[str, list[str]]:
        # Fast path: seeded bases are enough for common TLDs; refresh in background.
        if not self._bootstrap_ready:
            self.kick_bootstrap_refresh()
        return self._bootstrap

    def _tld(self, domain: str) -> str:
        return domain.rsplit(".", 1)[-1].lower()

    async def _rdap_urls_for(self, domain: str) -> list[str]:
        bootstrap = await self._ensure_bootstrap()
        bases = list(bootstrap.get(self._tld(domain), []))
        urls = [f"{base}/domain/{domain}" for base in bases]
        urls.append(RDAP_ORG_FALLBACK.format(domain=domain))
        # Deduplicate while preserving order.
        seen: set[str] = set()
        ordered: list[str] = []
        for u in urls:
            if u not in seen:
                seen.add(u)
                ordered.append(u)
        return ordered

    async def _rdap_lookup(self, domain: str) -> dict[str, Any]:
        urls = await self._rdap_urls_for(domain)
        last_error: str | None = None
        for url in urls:
            try:
                resp = await self._client.get(url)
            except httpx.HTTPError as exc:
                last_error = str(exc)
                continue

            if resp.status_code == 404:
                return {
                    "domain": domain,
                    "status": "available",
                    "source": "rdap",
                    "rdap_url": url,
                }
            if resp.status_code == 200:
                return {
                    "domain": domain,
                    "status": "registered",
                    "source": "rdap",
                    "rdap_url": url,
                }
            # 429 / 5xx / other → try next bootstrap URL
            last_error = f"HTTP {resp.status_code}"
        return {
            "domain": domain,
            "status": "unknown",
            "source": "rdap",
            "detail": last_error or "no RDAP response",
        }

    async def _dns_fallback(self, domain: str) -> dict[str, Any]:
        """NS or SOA presence ⇒ registered; NXDOMAIN ⇒ available."""
        resolver = dns.asyncresolver.Resolver()
        resolver.lifetime = DNS_LIFETIME
        try:
            await resolver.resolve(domain, dns.rdatatype.NS)
            return {"domain": domain, "status": "registered", "source": "dns"}
        except dns.resolver.NXDOMAIN:
            return {"domain": domain, "status": "available", "source": "dns"}
        except (dns.resolver.NoAnswer, dns.resolver.NoNameservers):
            # No NS answer — try SOA.
            try:
                await resolver.resolve(domain, dns.rdatatype.SOA)
                return {"domain": domain, "status": "registered", "source": "dns"}
            except dns.resolver.NXDOMAIN:
                return {"domain": domain, "status": "available", "source": "dns"}
            except Exception as exc:
                return {
                    "domain": domain,
                    "status": "unknown",
                    "source": "dns",
                    "detail": str(exc),
                }
        except Exception as exc:
            return {
                "domain": domain,
                "status": "unknown",
                "source": "dns",
                "detail": str(exc),
            }

