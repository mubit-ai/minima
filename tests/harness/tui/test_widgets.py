from __future__ import annotations

from minima_harness.minima.meter import CostMeter, CostRow
from minima_harness.tui.widgets.banner import render_banner
from minima_harness.tui.widgets.footer import render_footer


def test_render_footer_includes_model_cost_and_ctx():
    meter = CostMeter()
    html = render_footer(
        cwd="~/code/costit",
        session_id="a3f2",
        model="gemini-2.5-flash",
        basis="memory",
        meter=meter,
        input_tokens=1200,
        output_tokens=340,
        cache_read=0,
        cache_write=0,
        ctx_pct=12.0,
        routing_offline=False,
    )
    s = str(html)
    assert "model: gemini-2.5-flash ▸ memory" in s
    assert "$0.0000" in s
    assert "ctx 12%" in s


def test_render_footer_shows_offline_when_routing_offline():
    html = render_footer("d", "s", "m", "prior", CostMeter(), 0, 0, 0, 0, 0.0, True)
    assert "offline" in str(html).lower()


def test_render_footer_shows_savings_when_baseline_present():
    meter = CostMeter()
    meter.rows.append(
        CostRow(
            label="t",
            model="claude-haiku-4-5",
            decision_basis="memory",
            est_cost_usd=0.001,
            actual_cost_usd=0.0008,
            baseline_cost_usd=0.002,
            quality=0.9,
            outcome="success",
        )
    )
    s = str(render_footer("d", "s", "m", "memory", meter, 1, 2, 0, 0, 1.0, False))
    assert "save" in s and "vs base" in s


def test_render_footer_shows_cache_marker_when_tokens_cached():
    s = str(render_footer("d", "s", "m", "memory", CostMeter(), 10, 2, 500, 0, 1.0, False))
    assert "⚡500" in s


def test_render_footer_shows_thinking_level():
    s = str(
        render_footer(
            "d", "s", "m", "memory", CostMeter(), 1, 2, 0, 0, 1.0, False, thinking_level="high"
        )
    )
    assert "think: high" in s


def test_render_footer_marks_ephemeral_session():
    s = str(render_footer("d", "ephemeral", "m", "memory", CostMeter(), 1, 2, 0, 0, 1.0, False))
    assert "◈" in s and "ephemeral" in s


def test_render_banner_contains_reason():
    out = str(render_banner("recall_timeout — using gemini-2.5-flash"))
    assert "recall_timeout" in out
    assert "reconnect" in out.lower()


def test_render_notice_is_not_offline_framed():
    from minima_harness.tui.widgets.banner import render_notice

    out = str(render_notice("escalation_suggested:tie; reasoner_disabled"))
    assert "escalation_suggested" in out
    assert "offline" not in out.lower()  # routing succeeded — not an offline alarm
    assert "reconnect" not in out.lower()


def test_banner_warnings_suppresses_inline_warnings():
    from minima_harness.tui.app import _banner_warnings

    # the exact warnings from the bug report — both already shown inline, so banner stays empty
    assert _banner_warnings(["escalation_suggested:tie", "reasoner_disabled"]) == []
    assert _banner_warnings(["reasoner_consulted", "no_model_meets_threshold:x"]) == []
    # an unexpected warning still surfaces
    assert _banner_warnings(["catalog_stale", "escalation_suggested:tie"]) == ["catalog_stale"]
