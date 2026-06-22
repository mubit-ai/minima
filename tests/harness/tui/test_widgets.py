from __future__ import annotations

from minima_harness.minima.meter import CostMeter
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


def test_render_banner_contains_reason():
    out = str(render_banner("recall_timeout — using gemini-2.5-flash"))
    assert "recall_timeout" in out
    assert "reconnect" in out.lower()
