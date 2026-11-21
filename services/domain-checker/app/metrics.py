"""Lightweight request metrics for domain checks.

Counts HTTP `/api/domain` and MCP `check_domains` invocations (not health /
discovery noise). Aggregate totals only — no per-domain query logs.

Persistence: JSON file (METRICS_PATH, default under /tmp). Survives process
restarts when the path is on a durable volume; otherwise resets with the host.
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


def _hour_bucket(ts: float | None = None) -> int:
    t = int(ts if ts is not None else time.time())
    return t - (t % 3600)


@dataclass
class RequestMetrics:
    """Process-local counters with optional JSON file persistence."""

    path: Path = field(default_factory=lambda: Path(DEFAULT_METRICS_PATH))
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    total_checks: int = 0
    http_checks: int = 0
    mcp_checks: int = 0
    domains_checked: int = 0
    # hour_epoch -> {http, mcp, domains}
    hourly: dict[str, dict[str, int]] = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    persistence: str = "file"

    def __post_init__(self) -> None:
        self.path = Path(self.path)
        self._load()

    def _prune_hourly(self, now: float | None = None) -> None:
        cutoff = _hour_bucket(now) - 24 * 3600
        stale = [k for k in self.hourly if int(k) < cutoff]
        for k in stale:
            del self.hourly[k]

    def _load(self) -> None:
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

    def _save_unlocked(self) -> None:
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
            # Disk unavailable (e.g. read-only) — keep in-memory counts.
            self.persistence = "memory"

    def record(self, source: Source, domain_count: int = 0) -> None:
        """Record one check request from HTTP or MCP."""
        n = max(0, int(domain_count))
        with self._lock:
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
            self._save_unlocked()

    def snapshot(self) -> dict[str, Any]:
        """Public aggregate JSON (no domain names / query logs)."""
        with self._lock:
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


def reset_metrics(*, path: Path | str | None = None) -> RequestMetrics:
    """Replace the module singleton (tests)."""
    global metrics
    p = Path(path) if path is not None else Path(DEFAULT_METRICS_PATH)
    metrics = RequestMetrics(path=p)
    return metrics
