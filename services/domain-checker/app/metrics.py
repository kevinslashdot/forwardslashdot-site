"""Lightweight request metrics for domain checks.

Counts HTTP `/api/domain` and MCP `check_domains` invocations (not health /
discovery noise). Aggregate totals only — no per-domain query logs.

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

Source = Literal["http", "mcp"]

DEFAULT_METRICS_PATH = os.getenv(
    "METRICS_PATH",
    "/tmp/domain-checker-metrics.json",
)


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
            self.persistence = "postgres"
            self._pg_ready = True
            return True
        except Exception:
            self._pg_ready = False
            return False

    def _prune_hourly(self, now: float | None = None) -> None:
        cutoff = _hour_bucket(now) - 24 * 3600
        stale = [k for k in self.hourly if int(k) < cutoff]
        for k in stale:
            del self.hourly[k]

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

    def _record_postgres(self, source: Source, domain_count: int) -> bool:
        if not self._pg_ready or not self.database_url:
            return False
        try:
            import psycopg
        except ImportError:
            return False
        bucket = _hour_bucket()
        http_inc = 1 if source == "http" else 0
        mcp_inc = 1 if source == "mcp" else 0
        try:
            with psycopg.connect(self.database_url, connect_timeout=10) as conn:
                conn.execute(
                    f"""
                    UPDATE "{_pg_schema()}".metrics_totals SET
                      total_checks = total_checks + 1,
                      http_checks = http_checks + %s,
                      mcp_checks = mcp_checks + %s,
                      domains_checked = domains_checked + %s
                    WHERE id = 1
                    """,
                    (http_inc, mcp_inc, domain_count),
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
                    (bucket, http_inc, mcp_inc, domain_count),
                )
                # Drop buckets older than 24h
                cutoff = bucket - 24 * 3600
                conn.execute(
                    f'DELETE FROM "{_pg_schema()}".metrics_hourly WHERE hour_epoch < %s',
                    (cutoff,),
                )
                conn.commit()
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
            if not totals:
                return None
            last_http = int(hourly[0] or 0) if hourly else 0
            last_mcp = int(hourly[1] or 0) if hourly else 0
            last_domains = int(hourly[2] or 0) if hourly else 0
            started = float(totals[4]) if totals[4] is not None else self.started_at
            self.persistence = "postgres"
            return {
                "service": "domain-checker",
                "total_checks": int(totals[0] or 0),
                "by_source": {
                    "http": int(totals[1] or 0),
                    "mcp": int(totals[2] or 0),
                },
                "domains_checked": int(totals[3] or 0),
                "last_24h": {
                    "checks": last_http + last_mcp,
                    "http": last_http,
                    "mcp": last_mcp,
                    "domains_checked": last_domains,
                },
                "persistence": "postgres",
                "started_at": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)
                ),
            }
        except Exception:
            self._pg_ready = False
            return None

    def record(self, source: Source, domain_count: int = 0) -> None:
        """Record one check request from HTTP or MCP."""
        n = max(0, int(domain_count))
        with self._lock:
            if self._pg_ready and self._record_postgres(source, n):
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
            return {
                "service": "domain-checker",
                "total_checks": self.total_checks,
                "by_source": {
                    "http": self.http_checks,
                    "mcp": self.mcp_checks,
                },
                "domains_checked": self.domains_checked,
                "last_24h": {
                    "checks": last_24h_checks,
                    "http": last_24h_http,
                    "mcp": last_24h_mcp,
                    "domains_checked": last_24h_domains,
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
