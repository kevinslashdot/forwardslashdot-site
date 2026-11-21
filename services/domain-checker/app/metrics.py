"""Lightweight request metrics for domain checks and utility hits.

Counts HTTP `/api/domain`, MCP `check_domains`, and `/api/hit` (site areas).
Aggregate totals only — no per-domain query logs, no PII.

Persistence order:
1. Postgres when ``DATABASE_URL`` or ``NEON_DATABASE_URL`` is set (schema
   ``domain_checker`` — safe to share a Neon DB with Umami's public tables).
2. JSON file via ``METRICS_PATH`` (default under /tmp, Docker uses /data).
3. In-memory if the file path is unwritable.
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

Source = Literal["http", "mcp"]

ALLOWED_AREAS = frozenset(
    {
        "instant_domain_search",
        "world_time_converter",
        "other",
    }
)

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


def _empty_area() -> dict[str, int]:
    return {"checks": 0, "domains_checked": 0, "hits": 0}


def _area_payload(areas: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for name in sorted(ALLOWED_AREAS):
        slot = areas.get(name) or _empty_area()
        out[name] = {
            "checks": int(slot.get("checks") or 0),
            "domains_checked": int(slot.get("domains_checked") or 0),
            "hits": int(slot.get("hits") or 0),
        }
    return out


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
            self.persistence = "postgres"
            self._pg_ready = True
            return True
        except Exception:
            self._pg_ready = False
            return False

    def _refresh_areas_cache(self, conn: Any) -> None:
        rows = conn.execute(
            f"""
            SELECT area, checks, domains_checked, hits
            FROM "{_pg_schema()}".metrics_areas
            """
        ).fetchall()
        areas: dict[str, dict[str, int]] = {}
        for row in rows or []:
            areas[str(row[0])] = {
                "checks": int(row[1] or 0),
                "domains_checked": int(row[2] or 0),
                "hits": int(row[3] or 0),
            }
        self.areas = areas

    def _prune_hourly(self, now: float | None = None) -> None:
        cutoff = _hour_bucket(now) - 24 * 3600
        stale = [k for k in self.hourly if int(k) < cutoff]
        for k in stale:
            del self.hourly[k]
        stale_areas = [k for k in self.areas_hourly if int(k) < cutoff]
        for k in stale_areas:
            del self.areas_hourly[k]

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
                    slot = hour_slot.setdefault(area, {"checks": 0, "domains": 0, "hits": 0})
                    slot["checks"] += int(vals.get("checks") or 0)
                    slot["domains"] += int(vals.get("domains") or 0)
                    slot["hits"] += int(vals.get("hits") or 0)
                cleaned_ah[str(hour)] = hour_slot
            self.areas_hourly = cleaned_ah
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
    ) -> None:
        slot = self.areas.setdefault(area, _empty_area())
        slot["checks"] = int(slot.get("checks") or 0) + checks
        slot["domains_checked"] = int(slot.get("domains_checked") or 0) + domains
        slot["hits"] = int(slot.get("hits") or 0) + hits
        bucket = str(_hour_bucket())
        hour_map = self.areas_hourly.setdefault(bucket, {})
        hour_slot = hour_map.setdefault(area, {"checks": 0, "domains": 0, "hits": 0})
        hour_slot["checks"] = int(hour_slot.get("checks") or 0) + checks
        hour_slot["domains"] = int(hour_slot.get("domains") or 0) + domains
        hour_slot["hits"] = int(hour_slot.get("hits") or 0) + hits

    def _record_postgres(
        self,
        source: Source | None,
        domain_count: int,
        *,
        area: str,
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
                cutoff = bucket - 24 * 3600
                conn.execute(
                    f'DELETE FROM "{_pg_schema()}".metrics_hourly WHERE hour_epoch < %s',
                    (cutoff,),
                )
                conn.execute(
                    f'DELETE FROM "{_pg_schema()}".metrics_areas_hourly WHERE hour_epoch < %s',
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
                    SELECT area, checks, domains_checked, hits
                    FROM "{_pg_schema()}".metrics_areas
                    """
                ).fetchall()
                area_hourly_rows = conn.execute(
                    f"""
                    SELECT area,
                           COALESCE(SUM(checks),0),
                           COALESCE(SUM(domains),0),
                           COALESCE(SUM(hits),0)
                    FROM "{_pg_schema()}".metrics_areas_hourly
                    WHERE hour_epoch >= %s
                    GROUP BY area
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
                }
            last_areas: dict[str, dict[str, int]] = {}
            for row in area_hourly_rows or []:
                last_areas[str(row[0])] = {
                    "checks": int(row[1] or 0),
                    "domains_checked": int(row[2] or 0),
                    "hits": int(row[3] or 0),
                }
            self.persistence = "postgres"
            return {
                "service": "domain-checker",
                "total_checks": int(totals[0] or 0),
                "by_source": {
                    "http": int(totals[1] or 0),
                    "mcp": int(totals[2] or 0),
                },
                "by_area": _area_payload(areas),
                "domains_checked": int(totals[3] or 0),
                "last_24h": {
                    "checks": last_http + last_mcp,
                    "http": last_http,
                    "mcp": last_mcp,
                    "domains_checked": last_domains,
                    "by_area": _area_payload(last_areas),
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
    ) -> None:
        """Record one check request from HTTP or MCP."""
        n = max(0, int(domain_count))
        area_key = normalize_area(area if area is not None else ("other" if source == "mcp" else "other"))
        with self._lock:
            if self._pg_ready and self._record_postgres(
                source, n, area=area_key, checks=1
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
            self._save_file_unlocked()

    def record_hit(self, area: str | None = None) -> None:
        """Record one utility / page hit (no domain check)."""
        area_key = normalize_area(area)
        with self._lock:
            if self._pg_ready and self._record_postgres(
                None, 0, area=area_key, hits=1
            ):
                return
            self._bump_area_memory(area_key, hits=1)
            self._save_file_unlocked()

    def snapshot(self) -> dict[str, Any]:
        """Public aggregate JSON (no domain names / query logs)."""
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
            return {
                "service": "domain-checker",
                "total_checks": self.total_checks,
                "by_source": {
                    "http": self.http_checks,
                    "mcp": self.mcp_checks,
                },
                "by_area": _area_payload(self.areas),
                "domains_checked": self.domains_checked,
                "last_24h": {
                    "checks": last_24h_checks,
                    "http": last_24h_http,
                    "mcp": last_24h_mcp,
                    "domains_checked": last_24h_domains,
                    "by_area": _area_payload(last_areas),
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
