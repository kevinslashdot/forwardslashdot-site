"""Regional ending row: local defaults, then counts from checks."""

import importlib.util
from pathlib import Path

from app.endings import ending_of, row_for, sold_endings
from app.metrics import RequestMetrics

_SYNC_PATH = Path(__file__).resolve().parents[1] / "scripts" / "sync_namecheap_tlds.py"


def _sync_module():
    spec = importlib.util.spec_from_file_location("sync_namecheap_tlds", _SYNC_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_local_defaults_before_any_checks():
    canada, source = row_for("CA", {})
    assert source == "seed"
    assert canada[0] == ".ca"
    assert ".com" in canada
    assert len(canada) == 6

    australia, _ = row_for("AU", {})
    assert australia[0] == ".com.au"
    assert ".au" not in australia

    # Cloudflare calls the UK GB. A UK alias lands in the same row.
    assert row_for("GB", {})[0][0] == ".uk"
    assert row_for("UK", {})[0] == row_for("GB", {})[0]

    united_states, _ = row_for("US", {})
    assert united_states[0] == ".com"
    assert ".us" not in united_states


def test_unsold_endings_stay_off_the_row():
    allowed = {"com.au", "net.au", "org.au", "com", "net", "org", "io", "ai", "ca"}
    australia, source = row_for("AU", {"au": 80}, allowed=allowed)
    assert source == "seed"
    assert australia[0] == ".com.au"
    assert ".au" not in australia
    japan, _ = row_for("JP", {"jp": 40}, allowed=allowed)
    assert japan[0] == ".com"
    assert ".jp" not in japan


def test_checks_move_the_row_and_keep_the_local_name():
    # Ten .io checks outrank .net's prior, and .ca stays in front.
    canada, source = row_for("CA", {"io": 10, "com": 3})
    assert source == "live"
    assert canada[0] == ".ca"
    assert canada.index(".io") < canada.index(".net")


def test_ending_of_splits_country_and_second_level():
    assert ending_of("maple.ca") == "ca"
    assert ending_of("https://Example.COM.AU/path") == "com.au"
    assert ending_of("shop.co.uk") == "co.uk"
    assert ending_of("example.au") == "au"
    assert ending_of("not a domain") == ""


def test_catalog_is_what_namecheap_sells():
    endings = set(sold_endings())
    assert "com" in endings
    assert "ca" in endings
    assert "com.au" in endings
    assert "ai" in endings
    assert "au" not in endings
    assert "jp" not in endings


def test_sync_writes_only_when_the_set_changes(tmp_path: Path):
    sync = _sync_module()
    html = """
    <tr data-search="com namecheap.com"><a class="tld-link">.com</a></tr>
    <tr data-search="au porkbun.com"><a class="tld-link">.au</a></tr>
    <tr data-search="ca namecheap.com"><a class="tld-link">.ca</a></tr>
    """
    assert sync.parse_sold(html) == ["ca", "com"]
    path = tmp_path / "namecheap_tlds.json"
    added, removed = sync.sync(["ca", "com"], path)
    assert added == ["ca", "com"]
    assert removed == []
    added, removed = sync.sync(["ca", "com"], path)
    assert added == []
    assert removed == []
    added, removed = sync.sync(["ca", "com", "io"], path)
    assert added == ["io"]
    assert removed == []


def test_ending_counts_persist_without_the_domain(tmp_path: Path):
    path = tmp_path / "metrics.json"
    metrics = RequestMetrics(path=path, database_url=None)
    metrics.record_endings("CA", ["ca", "ca", "com"])
    metrics.record_endings("AU", ["au"])
    snap = metrics.snapshot()
    by_country = {row["ending"]: row["checks"] for row in snap["endings_by_country"]["CA"]}
    assert by_country["ca"] == 2
    assert by_country["com"] == 1
    assert snap["endings_by_country"]["AU"][0] == {"ending": "au", "checks": 1}

    reloaded = RequestMetrics(path=path, database_url=None)
    again = reloaded.ending_counts("ca")
    assert again["ca"] == 2
    row, source = row_for("CA", again)
    assert source == "live"
    assert row[0] == ".ca"
