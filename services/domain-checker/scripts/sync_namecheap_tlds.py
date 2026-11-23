"""Refresh the Namecheap endings catalog. Write the file only when the set changes.

Namecheap's own price API needs an account key, so the nightly job reads the
public registrar table at https://ds.aminul.dev/tlds/ and keeps an ending when
that table lists namecheap.com as a seller. A short or broken download is
refused, and an unchanged set does not touch the file.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

SOURCE_URL = "https://ds.aminul.dev/tlds/"
CATALOG_PATH = Path(__file__).resolve().parents[1] / "app" / "namecheap_tlds.json"
MIN_COUNT = 400
REQUIRED = frozenset({"com", "net", "org", "io", "co", "ai", "ca", "com.au"})
_ENDING_RE = re.compile(r"^(?:[a-z0-9-]{2,24}\.)?[a-z]{2,24}$")
_ROW_RE = re.compile(
    r'data-search="([^"]*)".{0,1200}?class="tld-link"[^>]*>\.([^<]+)',
    re.DOTALL,
)


def parse_sold(html: str) -> list[str]:
    """Bare endings whose row lists namecheap.com as a seller."""
    found: set[str] = set()
    for search, raw in _ROW_RE.findall(html):
        if "namecheap.com" not in search.split():
            continue
        ending = raw.strip().lower()
        if _ENDING_RE.match(ending) and not ending.startswith("xn--"):
            found.add(ending)
    return sorted(found)


def load_catalog(path: Path = CATALOG_PATH) -> list[str]:
    if not path.is_file():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    endings = raw.get("endings") if isinstance(raw, dict) else raw
    if not isinstance(endings, list):
        return []
    return [str(item) for item in endings]


def fetch_catalog(url: str = SOURCE_URL) -> list[str]:
    request = urllib.request.Request(url, headers={"User-Agent": "forwardslashdot-tld-sync"})
    with urllib.request.urlopen(request, timeout=60) as response:
        html = response.read().decode("utf-8", "replace")
    endings = parse_sold(html)
    missing = REQUIRED - set(endings)
    if len(endings) < MIN_COUNT or missing:
        raise RuntimeError(
            f"refusing to update: {len(endings)} endings, missing {sorted(missing)}"
        )
    return endings


def write_catalog(endings: list[str], path: Path = CATALOG_PATH) -> None:
    payload = {"source": SOURCE_URL, "endings": endings}
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def sync(endings: list[str] | None = None, path: Path = CATALOG_PATH) -> tuple[list[str], list[str]]:
    """Return (added, removed). Both empty when the stored set already matches."""
    fresh = fetch_catalog() if endings is None else list(endings)
    previous = load_catalog(path)
    if previous == fresh:
        return [], []
    added = sorted(set(fresh) - set(previous))
    removed = sorted(set(previous) - set(fresh))
    write_catalog(fresh, path)
    return added, removed


def main() -> int:
    try:
        added, removed = sync()
    except Exception as exc:
        print(f"sync failed: {exc}", file=sys.stderr)
        return 1
    if not added and not removed:
        print(f"unchanged ({len(load_catalog())} endings)")
        return 0
    print(f"added {len(added)}: {', '.join(added)}")
    print(f"removed {len(removed)}: {', '.join(removed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
