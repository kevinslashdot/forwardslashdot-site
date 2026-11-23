"""Which domain endings to show for a country.

There is no public live feed of “most registered ending by visitor country.”
Country registries publish their own namespace (.ca at CIRA, .au at auDA,
.uk at Nominet, .de at DENIC, and so on). Those local names are the seed.
Checks on this site then add to that seed: country and ending only, never
the domain that was typed.
"""

from __future__ import annotations

import re
from typing import Mapping

# The row everyone sees when we have no local default.
GLOBAL = ["com", "net", "org", "io", "co", "ai"]

# Local name first. The rest of the row is what people there register next.
# UK visitors arrive as GB (Cloudflare’s code).
SEED: dict[str, list[str]] = {
    "CA": ["ca", "com", "net", "org", "io", "ai"],
    "AU": ["au", "com.au", "com", "net", "io", "org"],
    "GB": ["uk", "co.uk", "com", "org", "io", "ai"],
    "DE": ["de", "com", "net", "org", "eu", "io"],
    "FR": ["fr", "com", "eu", "net", "org", "io"],
    "NL": ["nl", "com", "eu", "net", "org", "io"],
    "ES": ["es", "com", "net", "org", "eu", "io"],
    "IT": ["it", "com", "net", "org", "eu", "io"],
    "MX": ["mx", "com.mx", "com", "net", "org", "io"],
    "IN": ["in", "co.in", "com", "net", "org", "io"],
    "SG": ["sg", "com.sg", "com", "net", "org", "io"],
    "NZ": ["nz", "co.nz", "com", "net", "org", "io"],
    "IE": ["ie", "com", "net", "org", "eu", "io"],
    "SE": ["se", "com", "net", "org", "eu", "io"],
    "NO": ["no", "com", "net", "org", "eu", "io"],
    "DK": ["dk", "com", "net", "org", "eu", "io"],
    "FI": ["fi", "com", "net", "org", "eu", "io"],
    "CH": ["ch", "com", "net", "org", "io", "ai"],
    "AT": ["at", "com", "net", "org", "eu", "io"],
    "BE": ["be", "com", "net", "org", "eu", "io"],
    "PL": ["pl", "com", "net", "org", "eu", "io"],
    "PT": ["pt", "com", "net", "org", "eu", "io"],
    "BR": ["br", "com.br", "com", "net", "org", "io"],
    "JP": ["jp", "com", "net", "org", "io", "ai"],
    "KR": ["kr", "com", "net", "org", "io", "ai"],
    "CN": ["cn", "com", "net", "org", "io", "ai"],
    "HK": ["hk", "com", "net", "org", "io", "ai"],
    "TW": ["tw", "com", "net", "org", "io", "ai"],
    "ID": ["id", "com", "net", "org", "io", "ai"],
    "PH": ["ph", "com.ph", "com", "net", "org", "io"],
    "MY": ["my", "com", "net", "org", "io", "ai"],
    "ZA": ["co.za", "com", "net", "org", "io", "ai"],
    "AE": ["ae", "com", "net", "org", "io", "ai"],
    "PE": ["pe", "com.pe", "com", "net", "org", "io"],
}

# Two-label endings. A check of shop.co.uk counts as co.uk, not uk.
SECOND_LEVELS = frozenset(
    {
        "co.uk",
        "org.uk",
        "me.uk",
        "com.au",
        "net.au",
        "org.au",
        "co.nz",
        "com.br",
        "co.in",
        "com.mx",
        "com.sg",
        "com.ph",
        "com.pe",
        "co.za",
    }
)

ROW = 6
# Virtual checks so a handful of visits cannot throw out the local default.
PRIOR = 24

_ENDING_RE = re.compile(r"^(?:[a-z0-9-]{2,24}\.)?[a-z]{2,24}$")


def canonical_country(raw: str | None) -> str:
    code = str(raw or "").strip().upper()
    if code == "UK":
        return "GB"
    if code == "T1" or (len(code) == 2 and code.isalpha()):
        return code
    return "XX"


def normalize_ending(raw: str | None) -> str:
    text = str(raw or "").strip().lower().lstrip(".")
    if not _ENDING_RE.match(text):
        return ""
    for part in text.split("."):
        if part.startswith("-") or part.endswith("-"):
            return ""
    return text


def ending_of(domain: str | None) -> str:
    """Public ending of a domain. Empty when it is not a domain."""
    text = str(domain or "").strip().lower().rstrip(".")
    if "://" in text:
        text = text.split("://", 1)[1]
    text = text.split("/")[0].split("?")[0].split(":")[0]
    labels = [part for part in text.split(".") if part]
    if len(labels) < 2:
        return ""
    if len(labels) >= 3:
        tail = labels[-2] + "." + labels[-1]
        if tail in SECOND_LEVELS:
            return normalize_ending(tail)
    return normalize_ending(labels[-1])


def _seed_index(seed: list[str], item: str) -> int:
    try:
        return seed.index(item)
    except ValueError:
        return 99


def row_for(
    country: str | None,
    observed: Mapping[str, int] | None = None,
) -> tuple[list[str], str]:
    """Six endings for this country, local name pinned first.

    Returns dotted endings and ``seed`` or ``live``. ``live`` means at least
    one check from this country was counted.
    """
    code = canonical_country(country)
    seed = list(SEED.get(code) or GLOBAL)
    scores: dict[str, int] = {}
    weight = PRIOR
    for item in seed:
        scores[item] = scores.get(item, 0) + weight
        weight = max(2, weight // 2)
    total = 0
    for raw, count in (observed or {}).items():
        key = normalize_ending(str(raw))
        try:
            n = int(count or 0)
        except (TypeError, ValueError):
            n = 0
        if not key or n <= 0:
            continue
        scores[key] = scores.get(key, 0) + n
        total += n
    ranked = sorted(scores, key=lambda item: (-scores[item], _seed_index(seed, item), item))
    picked: list[str] = []
    if code in SEED and seed:
        picked.append(seed[0])
    for item in ranked:
        if item in picked:
            continue
        picked.append(item)
        if len(picked) >= ROW:
            break
    for item in GLOBAL:
        if len(picked) >= ROW:
            break
        if item not in picked:
            picked.append(item)
    dotted = ["." + item for item in picked[:ROW]]
    return dotted, ("live" if total else "seed")


def endings_payload(
    endings: Mapping[str, Mapping[str, int]],
) -> dict[str, list[dict[str, int | str]]]:
    """Top stored endings per country, for the stats page. No domain names."""
    out: dict[str, list[dict[str, int | str]]] = {}
    for raw_code, bucket in (endings or {}).items():
        if not isinstance(bucket, Mapping):
            continue
        code = canonical_country(str(raw_code))
        if code == "XX":
            continue
        items: list[tuple[str, int]] = []
        for raw_ending, raw_count in bucket.items():
            key = normalize_ending(str(raw_ending))
            try:
                n = int(raw_count or 0)
            except (TypeError, ValueError):
                n = 0
            if key and n > 0:
                items.append((key, n))
        if not items:
            continue
        items.sort(key=lambda pair: (-pair[1], pair[0]))
        out[code] = [{"ending": key, "checks": n} for key, n in items[:8]]
    return out
