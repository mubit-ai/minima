"""Tests for taskman.dates — parsing and the injectable today."""

from datetime import date

import pytest

from taskman.dates import (
    DateParseError,
    ENV_TODAY,
    add_days,
    days_between,
    humanize_delta,
    iso,
    parse_date,
    parse_optional_date,
    resolve_today,
)


def test_parse_date_valid():
    assert parse_date("2026-03-15") == date(2026, 3, 15)
    assert parse_date("  2026-01-02 ") == date(2026, 1, 2)


def test_parse_date_rejects_malformed_input():
    for bad in ("2026/03/15", "15-03-2026", "next week", "", "2026-3-5", "2026-02-30"):
        with pytest.raises(DateParseError):
            parse_date(bad)


def test_parse_optional_date():
    assert parse_optional_date(None) is None
    assert parse_optional_date("   ") is None
    assert parse_optional_date("2026-05-01") == date(2026, 5, 1)


def test_resolve_today_precedence(monkeypatch):
    monkeypatch.setenv(ENV_TODAY, "2026-03-15")
    assert resolve_today() == date(2026, 3, 15)
    # An explicit value (e.g. the --today flag) beats the environment.
    assert resolve_today(date(2026, 4, 1)) == date(2026, 4, 1)


def test_add_days_and_days_between():
    day = date(2026, 3, 15)
    assert add_days(day, 7) == date(2026, 3, 22)
    assert add_days(day, -1) == date(2026, 3, 14)
    assert days_between(day, date(2026, 3, 20)) == 5
    assert days_between(day, date(2026, 3, 10)) == -5


def test_humanize_delta_and_iso():
    today = date(2026, 3, 15)
    assert iso(None) == "-"
    assert iso(date(2026, 3, 15)) == "2026-03-15"
    assert humanize_delta(None, today) == "-"
    assert humanize_delta(date(2026, 3, 15), today) == "today"
    assert humanize_delta(date(2026, 3, 16), today) == "tomorrow"
    assert humanize_delta(date(2026, 3, 20), today) == "in 5d"
    assert humanize_delta(date(2026, 3, 14), today) == "yesterday"
    assert humanize_delta(date(2026, 3, 12), today) == "3d late"
