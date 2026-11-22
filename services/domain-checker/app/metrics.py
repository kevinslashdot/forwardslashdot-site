"""Lightweight request metrics for domain checks and utility hits.

Counts HTTP `/api/domain`, MCP `check_domains`, and `/api/hit` (site areas).
Aggregate totals only — no per-domain query logs, no PII, no raw IPs.
Coarse geo is ISO 3166-1 alpha-2 country codes from edge headers only.

Persistence order:
1. Postgres when ``DATABASE_URL`` or ``NEON_DATABASE_URL`` is set (schema
   ``domain_checker`` — safe to share a Neon DB with Umami's public tables).
2. JSON file via ``METRICS_PATH`` (default under /tmp, Docker uses /data).
3. In-memory if the file path is unwritable.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Mapping
from urllib.parse import urlparse

Source = Literal["http", "mcp"]

ALLOWED_AREAS = frozenset(
    {
        "instant_domain_search",
        "world_time_converter",
        "other",
    }
)

# Cloudflare / edge country headers only — never X-Forwarded-For or client IPs.
_COUNTRY_HEADER_NAMES = (
    "cf-ipcountry",
    "cloudflare-ipcountry",
    "cf-ip-country",
    "x-country-code",
    "x-appengine-country",
    "x-vercel-ip-country",
    "cloudfront-viewer-country",
)

# ISO 3166-1 alpha-2, plus Cloudflare specials XX (unknown) and T1 (Tor).
_COUNTRY_RE = re.compile(r"^[A-Z]{2}$|^T1$")
UNKNOWN_COUNTRY = "XX"

DEFAULT_METRICS_PATH = os.getenv(
    "METRICS_PATH",
    "/tmp/domain-checker-metrics.json",
)


def normalize_area(raw: str | None) -> str:
    """Map free-form area/source labels to a small public allow-list."""
    if not raw:
        return "other"
    key = str(raw).strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "domain": "instant_domain_search",
        "domains": "instant_domain_search",
        "instantdomainsearch": "instant_domain_search",
        "instant_domain": "instant_domain_search",
        "domain_search": "instant_domain_search",
        "time": "world_time_converter",
        "worldtime": "world_time_converter",
        "world_time": "world_time_converter",
        "worldtimeconverter": "world_time_converter",
        "time_converter": "world_time_converter",
    }
    key = aliases.get(key, key)
    return key if key in ALLOWED_AREAS else "other"


def normalize_country(raw: str | None) -> str:
    """Return a safe 2-letter (or CF T1) country code; never an IP or free text."""
    if not raw:
        return UNKNOWN_COUNTRY
    code = str(raw).strip().upper()
    # Reject anything that looks like an IP or longer token.
    if len(code) > 3 or "." in code or ":" in code:
        return UNKNOWN_COUNTRY
    if code in ("XX", "T1"):
        return code
    if _COUNTRY_RE.match(code) and code.isalpha():
        return code
    return UNKNOWN_COUNTRY


def country_from_headers(headers: Mapping[str, str] | None) -> str:
    """Prefer Cloudflare CF-IPCountry (and similar edge headers). Never use IP headers."""
    if not headers:
        return UNKNOWN_COUNTRY
    # Case-insensitive lookup without copying IPs into metrics.
    lowered = {str(k).lower(): str(v) for k, v in headers.items()}
    for name in _COUNTRY_HEADER_NAMES:
        if name in lowered:
            return normalize_country(lowered[name])
    return UNKNOWN_COUNTRY


def _pg_schema() -> str:
    # Isolate from Umami (or other apps) when sharing one Neon database.
    return (os.getenv("METRICS_PG_SCHEMA") or "domain_checker").strip() or "domain_checker"


def _database_url() -> str | None:
    for key in ("DATABASE_URL", "NEON_DATABASE_URL"):
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    return None


def _hour_bucket(ts: float | None = None) -> int:
    t = int(ts if ts is not None else time.time())
    return t - (t % 3600)


def _redacted_host(url: str) -> str:
    try:
        return urlparse(url).hostname or "postgres"
    except Exception:
        return "postgres"


_VISITOR_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
ACTORS = frozenset({"human", "llm"})


def normalize_actor(raw: str | None) -> str:
    """People are browsers. Models are fetches that never run the page."""
    key = (raw or "").strip().lower()
    if key in ("llm", "model", "bot", "mcp"):
        return "llm"
    return "human"


def normalize_day(raw: str | None) -> str:
    """Accept a local calendar day within a day of UTC, otherwise use UTC today."""
    today = datetime.now(timezone.utc).date()
    if not raw:
        return today.isoformat()
    try:
        day = datetime.strptime(str(raw).strip(), "%Y-%m-%d").date()
    except ValueError:
        return today.isoformat()
    if abs((day - today).days) > 1:
        return today.isoformat()
    return day.isoformat()


def audience_digest(area: str, actor: str, day: str, visitor: str) -> str:
    """One-way key for a device-day. The visitor id itself is not stored."""
    material = f"{area}|{actor}|{day}|{visitor}".encode()
    return hashlib.sha256(material).hexdigest()


def _empty_area() -> dict[str, int]:
    return {"checks": 0, "domains_checked": 0, "hits": 0, "human": 0, "llm": 0}


def _empty_country() -> dict[str, int]:
    return {"checks": 0, "domains_checked": 0, "hits": 0}


def _area_payload(areas: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for name in sorted(ALLOWED_AREAS):
        slot = areas.get(name) or _empty_area()
        out[name] = {
            "checks": int(slot.get("checks") or 0),
            "domains_checked": int(slot.get("domains_checked") or 0),
            "hits": int(slot.get("hits") or 0),
            "human": int(slot.get("human") or 0),
            "llm": int(slot.get("llm") or 0),
        }
    return out


def _country_payload(
    countries: dict[str, dict[str, int]],
) -> dict[str, dict[str, int]]:
    """Public country aggregates — codes only, sorted by activity then code."""
    items: list[tuple[str, dict[str, int]]] = []
    for code, slot in (countries or {}).items():
        safe = normalize_country(code)
        checks = int(slot.get("checks") or 0)
        domains = int(slot.get("domains_checked") or 0)
        hits = int(slot.get("hits") or 0)
        if checks == 0 and domains == 0 and hits == 0:
            continue
        items.append(
            (
                safe,
                {
                    "checks": checks,
                    "domains_checked": domains,
                    "hits": hits,
                },
            )
        )
    items.sort(
        key=lambda pair: (
            -(pair[1]["checks"] + pair[1]["hits"]),
            -(pair[1]["domains_checked"]),
            pair[0],
        )
    )
    return {code: vals for code, vals in items}


@dataclass
class RequestMetrics:
    """Aggregate counters with Postgres, file, or memory persistence."""

    path: Path = field(default_factory=lambda: Path(DEFAULT_METRICS_PATH))
    database_url: str | None = field(default_factory=_database_url)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    total_checks: int = 0
    http_checks: int = 0
    mcp_checks: int = 0
    domains_checked: int = 0
    # hour_epoch -> {http, mcp, domains}
    hourly: dict[str, dict[str, int]] = field(default_factory=dict)
    # area -> {checks, domains_checked, hits}
    areas: dict[str, dict[str, int]] = field(default_factory=dict)
    # hour_epoch -> area -> {checks, domains, hits}
    areas_hourly: dict[str, dict[str, dict[str, int]]] = field(default_factory=dict)
    # country_code -> {checks, domains_checked, hits}
    countries: dict[str, dict[str, int]] = field(default_factory=dict)
    # hour_epoch -> country -> {checks, domains, hits}
    countries_hourly: dict[str, dict[str, dict[str, int]]] = field(default_factory=dict)
    # sha256(area|actor|day|visitor) -> calendar day, so a device counts once
    seen: dict[str, str] = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    persistence: str = "file"
    _pg_ready: bool = field(default=False, repr=False)

    def __post_init__(self) -> None:
        self.path = Path(self.path)
        if self.database_url:
            if self._init_postgres():
                return
            # URL set but unreachable — fall through to file/memory.
            self.database_url = None
        self._load_file()

    def _init_postgres(self) -> bool:
        assert self.database_url
        try:
            import psycopg
        except ImportError:
            return False
        try:
            with psycopg.connect(self.database_url, connect_timeout=10) as conn:
                conn.execute(
                    f'CREATE SCHEMA IF NOT EXISTS "{_pg_schema()}"'
                )
                conn.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{_pg_schema()}".metrics_totals (
                      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                      total_checks BIGINT NOT NULL DEFAULT 0,
                      http_checks BIGINT NOT NULL DEFAULT 0,
                      mcp_checks BIGINT NOT NULL DEFAULT 0,
                      domains_checked BIGINT NOT NULL DEFAULT 0,
                      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                conn.execute(
                    f"""
                    INSERT INTO "{_pg_schema()}".metrics_totals (id)
                    VALUES (1)
                    ON CONFLICT (id) DO NOTHING
                    """
                )
                conn.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{_pg_schema()}".metrics_hourly (
                      hour_epoch BIGINT PRIMARY KEY,
                      http BIGINT NOT NULL DEFAULT 0,
                      mcp BIGINT NOT NULL DEFAULT 0,
                      domains BIGINT NOT NULL DEFAULT 0
                    )
                    """
                )
                conn.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{_pg_schema()}".metrics_areas (
                      area TEXT PRIMARY KEY,
                      checks BIGINT NOT NULL DEFAULT 0,
                      domains_checked BIGINT NOT NULL DEFAULT 0,
                      hits BIGINT NOT NULL DEFAULT 0
                    )
                    """
                )
                conn.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{_pg_schema()}".metrics_areas_hourly (
                      hour_epoch BIGINT NOT NULL,
                      area TEXT NOT NULL,
                      checks BIGINT NOT NULL DEFAULT 0,
                      domains BIGINT NOT NULL DEFAULT 0,
                      hits BIGINT NOT NULL DEFAULT 0,
                      PRIMARY KEY (hour_epoch, area)
                    )
                    """
                )
                conn.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{_pg_schema()}".metrics_countries (
                      country TEXT PRIMARY KEY,
                      checks BIGINT NOT NULL DEFAULT 0,
                      domains_checked BIGINT NOT NULL DEFAULT 0,
                      hits BIGINT NOT NULL DEFAULT 0
                    )
                    """
                )
                conn.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{_pg_schema()}".metrics_countries_hourly (
                      hour_epoch BIGINT NOT NULL,
                      country TEXT NOT NULL,
                      checks BIGINT NOT NULL DEFAULT 0,
                      domains BIGINT NOT NULL DEFAULT 0,
                      hits BIGINT NOT NULL DEFAULT 0,
                      PRIMARY KEY (hour_epoch, country)
                    )
                    """
                )
                conn.execute(
                    f"""
                    ALTER TABLE "{_pg_schema()}".metrics_areas
                      ADD COLUMN IF NOT EXISTS human_hits BIGINT NOT NULL DEFAULT 0,
                      ADD COLUMN IF NOT EXISTS llm_hits BIGINT NOT NULL DEFAULT 0
                    """
                )
                conn.execute(
                    f"""
                    ALTER TABLE "{_pg_schema()}".metrics_areas_hourly
                      ADD COLUMN IF NOT EXISTS human_hits BIGINT NOT NULL DEFAULT 0,
                      ADD COLUMN IF NOT EXISTS llm_hits BIGINT NOT NULL DEFAULT 0
                    """
                )
                conn.execute(
                    f"""
                    CREATE TABLE IF NOT EXISTS "{_pg_schema()}".metrics_seen (
                      seen_key TEXT PRIMARY KEY,
                      day DATE NOT NULL
                    )
                    """
                )
                for area in ALLOWED_AREAS:
                    conn.execute(
                        f"""
                        INSERT INTO "{_pg_schema()}".metrics_areas (area)
                        VALUES (%s)
                        ON CONFLICT (area) DO NOTHING
                        """,
                        (area,),
                    )
                conn.commit()
                row = conn.execute(
                    f"""
                    SELECT total_checks, http_checks, mcp_checks,
                           domains_checked, EXTRACT(EPOCH FROM started_at)
                    FROM "{_pg_schema()}".metrics_totals WHERE id = 1
                    """
                ).fetchone()
                if row:
                    self.total_checks = int(row[0] or 0)
                    self.http_checks = int(row[1] or 0)
                    self.mcp_checks = int(row[2] or 0)
                    self.domains_checked = int(row[3] or 0)
                    if row[4] is not None:
                        self.started_at = float(row[4])
                self._refresh_areas_cache(conn)
                self._refresh_countries_cache(conn)
            self.persistence = "postgres"
            self._pg_ready = True
            return True
        except Exception:
            self._pg_ready = False
            return False

    def _refresh_areas_cache(self, conn: Any) -> None:
        rows = conn.execute(
            f"""
            SELECT area, checks, domains_checked, hits, human_hits, llm_hits
            FROM "{_pg_schema()}".metrics_areas
            """
        ).fetchall()
        areas: dict[str, dict[str, int]] = {}
        for row in rows or []:
            areas[str(row[0])] = {
                "checks": int(row[1] or 0),
                "domains_checked": int(row[2] or 0),
                "hits": int(row[3] or 0),
                "human": int(row[4] or 0),
                "llm": int(row[5] or 0),
            }
        self.areas = areas

    def _refresh_countries_cache(self, conn: Any) -> None:
        rows = conn.execute(
            f"""
            SELECT country, checks, domains_checked, hits
            FROM "{_pg_schema()}".metrics_countries
            """
        ).fetchall()
        countries: dict[str, dict[str, int]] = {}
        for row in rows or []:
            code = normalize_country(str(row[0]))
            slot = countries.setdefault(code, _empty_country())
            slot["checks"] += int(row[1] or 0)
            slot["domains_checked"] += int(row[2] or 0)
            slot["hits"] += int(row[3] or 0)
        self.countries = countries

    def _prune_hourly(self, now: float | None = None) -> None:
        cutoff = _hour_bucket(now) - 24 * 3600
        stale = [k for k in self.hourly if int(k) < cutoff]
        for k in stale:
            del self.hourly[k]
        stale_areas = [k for k in self.areas_hourly if int(k) < cutoff]
        for k in stale_areas:
            del self.areas_hourly[k]
        stale_countries = [k for k in self.countries_hourly if int(k) < cutoff]
        for k in stale_countries:
            del self.countries_hourly[k]
        keep_after = (datetime.now(timezone.utc).date() - timedelta(days=3)).isoformat()
        self.seen = {key: day for key, day in self.seen.items() if day >= keep_after}

    def _load_file(self) -> None:
        try:
            if not self.path.is_file():
                return
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            return
        self.total_checks = int(raw.get("total_checks") or 0)
        self.http_checks = int(raw.get("http_checks") or 0)
        self.mcp_checks = int(raw.get("mcp_checks") or 0)
        self.domains_checked = int(raw.get("domains_checked") or 0)
        hourly = raw.get("hourly") or {}
        if isinstance(hourly, dict):
            cleaned: dict[str, dict[str, int]] = {}
            for k, v in hourly.items():
                if not isinstance(v, dict):
                    continue
                cleaned[str(k)] = {
                    "http": int(v.get("http") or 0),
                    "mcp": int(v.get("mcp") or 0),
                    "domains": int(v.get("domains") or 0),
                }
            self.hourly = cleaned
        areas_raw = raw.get("areas") or {}
        if isinstance(areas_raw, dict):
            cleaned_areas: dict[str, dict[str, int]] = {}
            for k, v in areas_raw.items():
                if not isinstance(v, dict):
                    continue
                area = normalize_area(str(k))
                slot = cleaned_areas.setdefault(area, _empty_area())
                slot["checks"] += int(v.get("checks") or 0)
                slot["domains_checked"] += int(v.get("domains_checked") or 0)
                slot["hits"] += int(v.get("hits") or 0)
                slot["human"] += int(v.get("human") or 0)
                slot["llm"] += int(v.get("llm") or 0)
            self.areas = cleaned_areas
        areas_hourly = raw.get("areas_hourly") or {}
        if isinstance(areas_hourly, dict):
            cleaned_ah: dict[str, dict[str, dict[str, int]]] = {}
            for hour, by_area in areas_hourly.items():
                if not isinstance(by_area, dict):
                    continue
                hour_slot: dict[str, dict[str, int]] = {}
                for area_name, vals in by_area.items():
                    if not isinstance(vals, dict):
                        continue
                    area = normalize_area(str(area_name))
                    slot = hour_slot.setdefault(area, {"checks": 0, "domains": 0, "hits": 0, "human": 0, "llm": 0})
                    slot["checks"] += int(vals.get("checks") or 0)
                    slot["domains"] += int(vals.get("domains") or 0)
                    slot["hits"] += int(vals.get("hits") or 0)
                    slot["human"] += int(vals.get("human") or 0)
                    slot["llm"] += int(vals.get("llm") or 0)
                cleaned_ah[str(hour)] = hour_slot
            self.areas_hourly = cleaned_ah
        countries_raw = raw.get("countries") or {}
        if isinstance(countries_raw, dict):
            cleaned_countries: dict[str, dict[str, int]] = {}
            for k, v in countries_raw.items():
                if not isinstance(v, dict):
                    continue
                code = normalize_country(str(k))
                slot = cleaned_countries.setdefault(code, _empty_country())
                slot["checks"] += int(v.get("checks") or 0)
                slot["domains_checked"] += int(v.get("domains_checked") or 0)
                slot["hits"] += int(v.get("hits") or 0)
            self.countries = cleaned_countries
        countries_hourly = raw.get("countries_hourly") or {}
        if isinstance(countries_hourly, dict):
            cleaned_ch: dict[str, dict[str, dict[str, int]]] = {}
            for hour, by_country in countries_hourly.items():
                if not isinstance(by_country, dict):
                    continue
                hour_slot: dict[str, dict[str, int]] = {}
                for country_name, vals in by_country.items():
                    if not isinstance(vals, dict):
                        continue
                    code = normalize_country(str(country_name))
                    slot = hour_slot.setdefault(code, {"checks": 0, "domains": 0, "hits": 0})
                    slot["checks"] += int(vals.get("checks") or 0)
                    slot["domains"] += int(vals.get("domains") or 0)
                    slot["hits"] += int(vals.get("hits") or 0)
                cleaned_ch[str(hour)] = hour_slot
            self.countries_hourly = cleaned_ch
        seen_raw = raw.get("seen") or {}
        if isinstance(seen_raw, dict):
            self.seen = {
                str(key): str(day)
                for key, day in seen_raw.items()
                if isinstance(key, str) and isinstance(day, str)
            }
        if raw.get("started_at"):
            try:
                self.started_at = float(raw["started_at"])
            except (TypeError, ValueError):
                pass
        self._prune_hourly()

    def _save_file_unlocked(self) -> None:
        self._prune_hourly()
        payload = {
            "total_checks": self.total_checks,
            "http_checks": self.http_checks,
            "mcp_checks": self.mcp_checks,
            "domains_checked": self.domains_checked,
            "hourly": self.hourly,
            "areas": self.areas,
            "areas_hourly": self.areas_hourly,
            "countries": self.countries,
            "countries_hourly": self.countries_hourly,
            "seen": self.seen,
            "started_at": self.started_at,
        }
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            tmp.replace(self.path)
            self.persistence = "file"
        except OSError:
            self.persistence = "memory"

    def _bump_area_memory(
        self,
        area: str,
        *,
        checks: int = 0,
        domains: int = 0,
        hits: int = 0,
        human: int = 0,
        llm: int = 0,
    ) -> None:
        slot = self.areas.setdefault(area, _empty_area())
        slot["checks"] = int(slot.get("checks") or 0) + checks
        slot["domains_checked"] = int(slot.get("domains_checked") or 0) + domains
        slot["hits"] = int(slot.get("hits") or 0) + hits
        slot["human"] = int(slot.get("human") or 0) + human
        slot["llm"] = int(slot.get("llm") or 0) + llm
        bucket = str(_hour_bucket())
        hour_map = self.areas_hourly.setdefault(bucket, {})
        hour_slot = hour_map.setdefault(area, {"checks": 0, "domains": 0, "hits": 0, "human": 0, "llm": 0})
        hour_slot["checks"] = int(hour_slot.get("checks") or 0) + checks
        hour_slot["domains"] = int(hour_slot.get("domains") or 0) + domains
        hour_slot["hits"] = int(hour_slot.get("hits") or 0) + hits
        hour_slot["human"] = int(hour_slot.get("human") or 0) + human
        hour_slot["llm"] = int(hour_slot.get("llm") or 0) + llm

    def _bump_country_memory(
        self,
        country: str,
        *,
        checks: int = 0,
        domains: int = 0,
        hits: int = 0,
    ) -> None:
        code = normalize_country(country)
        slot = self.countries.setdefault(code, _empty_country())
        slot["checks"] = int(slot.get("checks") or 0) + checks
        slot["domains_checked"] = int(slot.get("domains_checked") or 0) + domains
        slot["hits"] = int(slot.get("hits") or 0) + hits
        bucket = str(_hour_bucket())
        hour_map = self.countries_hourly.setdefault(bucket, {})
        hour_slot = hour_map.setdefault(code, {"checks": 0, "domains": 0, "hits": 0})
        hour_slot["checks"] = int(hour_slot.get("checks") or 0) + checks
        hour_slot["domains"] = int(hour_slot.get("domains") or 0) + domains
        hour_slot["hits"] = int(hour_slot.get("hits") or 0) + hits

    def _record_postgres(
        self,
        source: Source | None,
        domain_count: int,
        *,
        area: str,
        country: str = UNKNOWN_COUNTRY,
        hits: int = 0,
        checks: int = 0,
    ) -> bool:
        if not self._pg_ready or not self.database_url:
            return False
        try:
            import psycopg
        except ImportError:
            return False
        bucket = _hour_bucket()
        http_inc = 1 if source == "http" else 0
        mcp_inc = 1 if source == "mcp" else 0
        check_inc = max(0, int(checks))
        hit_inc = max(0, int(hits))
        domain_inc = max(0, int(domain_count))
        country_code = normalize_country(country)
        try:
            with psycopg.connect(self.database_url, connect_timeout=10) as conn:
                if source is not None:
                    conn.execute(
                        f"""
                        UPDATE "{_pg_schema()}".metrics_totals SET
                          total_checks = total_checks + %s,
                          http_checks = http_checks + %s,
                          mcp_checks = mcp_checks + %s,
                          domains_checked = domains_checked + %s
                        WHERE id = 1
                        """,
                        (check_inc, http_inc, mcp_inc, domain_inc),
                    )
                    conn.execute(
                        f"""
                        INSERT INTO "{_pg_schema()}".metrics_hourly
                          (hour_epoch, http, mcp, domains)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (hour_epoch) DO UPDATE SET
                          http = "{_pg_schema()}".metrics_hourly.http + EXCLUDED.http,
                          mcp = "{_pg_schema()}".metrics_hourly.mcp + EXCLUDED.mcp,
                          domains = "{_pg_schema()}".metrics_hourly.domains
                                     + EXCLUDED.domains
                        """,
                        (bucket, http_inc, mcp_inc, domain_inc),
                    )
                conn.execute(
                    f"""
                    INSERT INTO "{_pg_schema()}".metrics_areas
                      (area, checks, domains_checked, hits)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (area) DO UPDATE SET
                      checks = "{_pg_schema()}".metrics_areas.checks + EXCLUDED.checks,
                      domains_checked = "{_pg_schema()}".metrics_areas.domains_checked
                                        + EXCLUDED.domains_checked,
                      hits = "{_pg_schema()}".metrics_areas.hits + EXCLUDED.hits
                    """,
                    (area, check_inc, domain_inc, hit_inc),
                )
                conn.execute(
                    f"""
                    INSERT INTO "{_pg_schema()}".metrics_areas_hourly
                      (hour_epoch, area, checks, domains, hits)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (hour_epoch, area) DO UPDATE SET
                      checks = "{_pg_schema()}".metrics_areas_hourly.checks
                               + EXCLUDED.checks,
                      domains = "{_pg_schema()}".metrics_areas_hourly.domains
                                + EXCLUDED.domains,
                      hits = "{_pg_schema()}".metrics_areas_hourly.hits
                             + EXCLUDED.hits
                    """,
                    (bucket, area, check_inc, domain_inc, hit_inc),
                )
                conn.execute(
                    f"""
                    INSERT INTO "{_pg_schema()}".metrics_countries
                      (country, checks, domains_checked, hits)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (country) DO UPDATE SET
                      checks = "{_pg_schema()}".metrics_countries.checks
                               + EXCLUDED.checks,
                      domains_checked = "{_pg_schema()}".metrics_countries.domains_checked
                                        + EXCLUDED.domains_checked,
                      hits = "{_pg_schema()}".metrics_countries.hits + EXCLUDED.hits
                    """,
                    (country_code, check_inc, domain_inc, hit_inc),
                )
                conn.execute(
                    f"""
                    INSERT INTO "{_pg_schema()}".metrics_countries_hourly
                      (hour_epoch, country, checks, domains, hits)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (hour_epoch, country) DO UPDATE SET
                      checks = "{_pg_schema()}".metrics_countries_hourly.checks
                               + EXCLUDED.checks,
                      domains = "{_pg_schema()}".metrics_countries_hourly.domains
                                + EXCLUDED.domains,
                      hits = "{_pg_schema()}".metrics_countries_hourly.hits
                             + EXCLUDED.hits
                    """,
                    (bucket, country_code, check_inc, domain_inc, hit_inc),
                )
                cutoff = bucket - 24 * 3600
                conn.execute(
                    f'DELETE FROM "{_pg_schema()}".metrics_hourly WHERE hour_epoch < %s',
                    (cutoff,),
                )
                conn.execute(
                    f'DELETE FROM "{_pg_schema()}".metrics_areas_hourly WHERE hour_epoch < %s',
                    (cutoff,),
                )
                conn.execute(
                    f'DELETE FROM "{_pg_schema()}".metrics_countries_hourly WHERE hour_epoch < %s',
                    (cutoff,),
                )
                conn.commit()
                if source is not None:
                    row = conn.execute(
                        f"""
                        SELECT total_checks, http_checks, mcp_checks, domains_checked
                        FROM "{_pg_schema()}".metrics_totals WHERE id = 1
                        """
                    ).fetchone()
                    if row:
                        self.total_checks = int(row[0] or 0)
                        self.http_checks = int(row[1] or 0)
                        self.mcp_checks = int(row[2] or 0)
                        self.domains_checked = int(row[3] or 0)
                self._refresh_areas_cache(conn)
                self._refresh_countries_cache(conn)
            self.persistence = "postgres"
            return True
        except Exception:
            self._pg_ready = False
            return False

    def _snapshot_postgres(self) -> dict[str, Any] | None:
        if not self._pg_ready or not self.database_url:
            return None
        try:
            import psycopg
        except ImportError:
            return None
        cutoff = _hour_bucket() - 24 * 3600
        try:
            with psycopg.connect(self.database_url, connect_timeout=10) as conn:
                totals = conn.execute(
                    f"""
                    SELECT total_checks, http_checks, mcp_checks,
                           domains_checked, EXTRACT(EPOCH FROM started_at)
                    FROM "{_pg_schema()}".metrics_totals WHERE id = 1
                    """
                ).fetchone()
                hourly = conn.execute(
                    f"""
                    SELECT COALESCE(SUM(http),0), COALESCE(SUM(mcp),0),
                           COALESCE(SUM(domains),0)
                    FROM "{_pg_schema()}".metrics_hourly
                    WHERE hour_epoch >= %s
                    """,
                    (cutoff,),
                ).fetchone()
                area_rows = conn.execute(
                    f"""
                    SELECT area, checks, domains_checked, hits, human_hits, llm_hits
                    FROM "{_pg_schema()}".metrics_areas
                    """
                ).fetchall()
                area_hourly_rows = conn.execute(
                    f"""
                    SELECT area,
                           COALESCE(SUM(checks),0),
                           COALESCE(SUM(domains),0),
                           COALESCE(SUM(hits),0),
                           COALESCE(SUM(human_hits),0),
                           COALESCE(SUM(llm_hits),0)
                    FROM "{_pg_schema()}".metrics_areas_hourly
                    WHERE hour_epoch >= %s
                    GROUP BY area
                    """,
                    (cutoff,),
                ).fetchall()
                country_rows = conn.execute(
                    f"""
                    SELECT country, checks, domains_checked, hits
                    FROM "{_pg_schema()}".metrics_countries
                    """
                ).fetchall()
                country_hourly_rows = conn.execute(
                    f"""
                    SELECT country,
                           COALESCE(SUM(checks),0),
                           COALESCE(SUM(domains),0),
                           COALESCE(SUM(hits),0)
                    FROM "{_pg_schema()}".metrics_countries_hourly
                    WHERE hour_epoch >= %s
                    GROUP BY country
                    """,
                    (cutoff,),
                ).fetchall()
            if not totals:
                return None
            last_http = int(hourly[0] or 0) if hourly else 0
            last_mcp = int(hourly[1] or 0) if hourly else 0
            last_domains = int(hourly[2] or 0) if hourly else 0
            started = float(totals[4]) if totals[4] is not None else self.started_at
            areas: dict[str, dict[str, int]] = {}
            for row in area_rows or []:
                areas[str(row[0])] = {
                    "checks": int(row[1] or 0),
                    "domains_checked": int(row[2] or 0),
                    "hits": int(row[3] or 0),
                    "human": int(row[4] or 0) if len(row) > 4 else 0,
                    "llm": int(row[5] or 0) if len(row) > 5 else 0,
                }
            last_areas: dict[str, dict[str, int]] = {}
            for row in area_hourly_rows or []:
                last_areas[str(row[0])] = {
                    "checks": int(row[1] or 0),
                    "domains_checked": int(row[2] or 0),
                    "hits": int(row[3] or 0),
                    "human": int(row[4] or 0) if len(row) > 4 else 0,
                    "llm": int(row[5] or 0) if len(row) > 5 else 0,
                }
            countries: dict[str, dict[str, int]] = {}
            for row in country_rows or []:
                code = normalize_country(str(row[0]))
                slot = countries.setdefault(code, _empty_country())
                slot["checks"] += int(row[1] or 0)
                slot["domains_checked"] += int(row[2] or 0)
                slot["hits"] += int(row[3] or 0)
            last_countries: dict[str, dict[str, int]] = {}
            for row in country_hourly_rows or []:
                code = normalize_country(str(row[0]))
                slot = last_countries.setdefault(code, _empty_country())
                slot["checks"] += int(row[1] or 0)
                slot["domains_checked"] += int(row[2] or 0)
                slot["hits"] += int(row[3] or 0)
            self.persistence = "postgres"
            return {
                "service": "domain-checker",
                "total_checks": int(totals[0] or 0),
                "by_source": {
                    "http": int(totals[1] or 0),
                    "mcp": int(totals[2] or 0),
                },
                "by_area": _area_payload(areas),
                "by_country": _country_payload(countries),
                "domains_checked": int(totals[3] or 0),
                "last_24h": {
                    "checks": last_http + last_mcp,
                    "http": last_http,
                    "mcp": last_mcp,
                    "domains_checked": last_domains,
                    "by_area": _area_payload(last_areas),
                    "by_country": _country_payload(last_countries),
                },
                "persistence": "postgres",
                "started_at": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)
                ),
            }
        except Exception:
            self._pg_ready = False
            return None

    def record(
        self,
        source: Source,
        domain_count: int = 0,
        *,
        area: str | None = None,
        country: str | None = None,
    ) -> None:
        """Record one check request from HTTP or MCP."""
        n = max(0, int(domain_count))
        area_key = normalize_area(area if area is not None else ("other" if source == "mcp" else "other"))
        country_key = normalize_country(country)
        with self._lock:
            if self._pg_ready and self._record_postgres(
                source, n, area=area_key, country=country_key, checks=1
            ):
                return
            self.total_checks += 1
            if source == "http":
                self.http_checks += 1
            else:
                self.mcp_checks += 1
            self.domains_checked += n
            bucket = str(_hour_bucket())
            slot = self.hourly.setdefault(
                bucket, {"http": 0, "mcp": 0, "domains": 0}
            )
            slot[source] = int(slot.get(source) or 0) + 1
            slot["domains"] = int(slot.get("domains") or 0) + n
            self._bump_area_memory(area_key, checks=1, domains=n)
            self._bump_country_memory(country_key, checks=1, domains=n)
            self._save_file_unlocked()

    def record_hit(
        self,
        area: str | None = None,
        *,
        country: str | None = None,
    ) -> None:
        """Record one utility / page hit (no domain check)."""
        area_key = normalize_area(area)
        country_key = normalize_country(country)
        with self._lock:
            if self._pg_ready and self._record_postgres(
                None, 0, area=area_key, country=country_key, hits=1
            ):
                return
            self._bump_area_memory(area_key, hits=1)
            self._bump_country_memory(country_key, hits=1)
            self._save_file_unlocked()

    def record_audience(
        self,
        area: str | None,
        *,
        actor: str | None,
        visitor: str | None,
        day: str | None,
        country: str | None = None,
    ) -> bool:
        """Count one person or model. The same visitor counts once per calendar day.

        Returns True when this call incremented the counter.
        A missing or malformed visitor is counted every time (older beacons).
        """
        area_key = normalize_area(area)
        actor_key = normalize_actor(actor)
        day_key = normalize_day(day)
        country_key = normalize_country(country)
        visitor_id = (visitor or "").strip()
        dedupe = bool(_VISITOR_RE.match(visitor_id))
        seen_key = audience_digest(area_key, actor_key, day_key, visitor_id) if dedupe else ""
        human = 1 if actor_key == "human" else 0
        llm = 1 if actor_key == "llm" else 0
        with self._lock:
            if self._pg_ready:
                recorded = self._record_audience_postgres(
                    area_key,
                    actor_key,
                    seen_key,
                    day_key,
                    country_key,
                    human=human,
                    llm=llm,
                )
                if recorded is not None:
                    return recorded
            if seen_key and seen_key in self.seen:
                return False
            if seen_key:
                self.seen[seen_key] = day_key
            self._bump_area_memory(area_key, hits=1, human=human, llm=llm)
            self._bump_country_memory(country_key, hits=1)
            self._save_file_unlocked()
            return True

    def _record_audience_postgres(
        self,
        area: str,
        actor: str,
        seen_key: str,
        day: str,
        country: str,
        *,
        human: int,
        llm: int,
    ) -> bool | None:
        """True recorded, False duplicate, None if Postgres is unavailable."""
        if not self._pg_ready or not self.database_url:
            return None
        try:
            import psycopg
        except ImportError:
            return None
        bucket = _hour_bucket()
        try:
            with psycopg.connect(self.database_url, connect_timeout=10) as conn:
                if seen_key:
                    inserted = conn.execute(
                        f"""
                        INSERT INTO "{_pg_schema()}".metrics_seen (seen_key, day)
                        VALUES (%s, %s)
                        ON CONFLICT (seen_key) DO NOTHING
                        RETURNING seen_key
                        """,
                        (seen_key, day),
                    ).fetchone()
                    if inserted is None:
                        conn.commit()
                        return False
                    conn.execute(
                        f"""
                        DELETE FROM "{_pg_schema()}".metrics_seen
                        WHERE day < %s::date
                        """,
                        ((datetime.now(timezone.utc).date() - timedelta(days=3)).isoformat(),),
                    )
                conn.execute(
                    f"""
                    INSERT INTO "{_pg_schema()}".metrics_areas
                      (area, hits, human_hits, llm_hits)
                    VALUES (%s, 1, %s, %s)
                    ON CONFLICT (area) DO UPDATE SET
                      hits = "{_pg_schema()}".metrics_areas.hits + 1,
                      human_hits = "{_pg_schema()}".metrics_areas.human_hits + EXCLUDED.human_hits,
                      llm_hits = "{_pg_schema()}".metrics_areas.llm_hits + EXCLUDED.llm_hits
                    """,
                    (area, human, llm),
                )
                conn.execute(
                    f"""
                    INSERT INTO "{_pg_schema()}".metrics_areas_hourly
                      (hour_epoch, area, hits, human_hits, llm_hits)
                    VALUES (%s, %s, 1, %s, %s)
                    ON CONFLICT (hour_epoch, area) DO UPDATE SET
                      hits = "{_pg_schema()}".metrics_areas_hourly.hits + 1,
                      human_hits = "{_pg_schema()}".metrics_areas_hourly.human_hits
                                   + EXCLUDED.human_hits,
                      llm_hits = "{_pg_schema()}".metrics_areas_hourly.llm_hits
                                 + EXCLUDED.llm_hits
                    """,
                    (bucket, area, human, llm),
                )
                conn.execute(
                    f"""
                    INSERT INTO "{_pg_schema()}".metrics_countries
                      (country, hits)
                    VALUES (%s, 1)
                    ON CONFLICT (country) DO UPDATE SET
                      hits = "{_pg_schema()}".metrics_countries.hits + 1
                    """,
                    (country,),
                )
                conn.execute(
                    f"""
                    INSERT INTO "{_pg_schema()}".metrics_countries_hourly
                      (hour_epoch, country, hits)
                    VALUES (%s, %s, 1)
                    ON CONFLICT (hour_epoch, country) DO UPDATE SET
                      hits = "{_pg_schema()}".metrics_countries_hourly.hits + 1
                    """,
                    (bucket, country),
                )
                conn.commit()
                self._refresh_areas_cache(conn)
                self._refresh_countries_cache(conn)
            self.persistence = "postgres"
            return True
        except Exception:
            self._pg_ready = False
            return None

    def snapshot(self) -> dict[str, Any]:
        """Public aggregate JSON (no domain names / query logs / IPs)."""
        with self._lock:
            if self._pg_ready:
                snap = self._snapshot_postgres()
                if snap is not None:
                    return snap
            self._prune_hourly()
            last_24h_checks = 0
            last_24h_http = 0
            last_24h_mcp = 0
            last_24h_domains = 0
            for slot in self.hourly.values():
                last_24h_http += int(slot.get("http") or 0)
                last_24h_mcp += int(slot.get("mcp") or 0)
                last_24h_domains += int(slot.get("domains") or 0)
            last_24h_checks = last_24h_http + last_24h_mcp
            last_areas: dict[str, dict[str, int]] = {}
            for hour_map in self.areas_hourly.values():
                for area_name, vals in hour_map.items():
                    slot = last_areas.setdefault(area_name, _empty_area())
                    slot["checks"] += int(vals.get("checks") or 0)
                    slot["domains_checked"] += int(vals.get("domains") or 0)
                    slot["hits"] += int(vals.get("hits") or 0)
                    slot["human"] += int(vals.get("human") or 0)
                    slot["llm"] += int(vals.get("llm") or 0)
            last_countries: dict[str, dict[str, int]] = {}
            for hour_map in self.countries_hourly.values():
                for country_name, vals in hour_map.items():
                    code = normalize_country(country_name)
                    slot = last_countries.setdefault(code, _empty_country())
                    slot["checks"] += int(vals.get("checks") or 0)
                    slot["domains_checked"] += int(vals.get("domains") or 0)
                    slot["hits"] += int(vals.get("hits") or 0)
            return {
                "service": "domain-checker",
                "total_checks": self.total_checks,
                "by_source": {
                    "http": self.http_checks,
                    "mcp": self.mcp_checks,
                },
                "by_area": _area_payload(self.areas),
                "by_country": _country_payload(self.countries),
                "domains_checked": self.domains_checked,
                "last_24h": {
                    "checks": last_24h_checks,
                    "http": last_24h_http,
                    "mcp": last_24h_mcp,
                    "domains_checked": last_24h_domains,
                    "by_area": _area_payload(last_areas),
                    "by_country": _country_payload(last_countries),
                },
                "persistence": self.persistence,
                "started_at": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.started_at)
                ),
            }


# Module singleton — created at import; path overridable in tests via reset.
metrics = RequestMetrics()


def reset_metrics(
    *,
    path: Path | str | None = None,
    database_url: str | None | object = ...,
) -> RequestMetrics:
    """Replace the module singleton (tests).

    Pass ``database_url=None`` to force file/memory even if env has a URL.
    Omit ``database_url`` to read ``DATABASE_URL`` / ``NEON_DATABASE_URL``.
    """
    global metrics
    p = Path(path) if path is not None else Path(DEFAULT_METRICS_PATH)
    if database_url is ...:
        metrics = RequestMetrics(path=p)
    else:
        metrics = RequestMetrics(path=p, database_url=database_url)  # type: ignore[arg-type]
    return metrics
