"""Example 5 — Zero-code intake via mubit.learn autocapture.

If you don't want to call /feedback explicitly, `costit_client.autocapture` pins a
`mubit.learn` session to the SAME memory lane Costit recalls from and monkeypatches your
OpenAI/Anthropic/LiteLLM/Google-GenAI clients, so every LLM call you make auto-ingests its
trace into Costit's lane — no changes at the call site.

What autocapture does NOT do: fabricate a success signal. `mubit.learn` never decides an
answer was "good". You still close the loop with a quality signal — either
`autocapture.feedback(...)` (credits the recalled entries) or `POST /v1/feedback`.

Requires mubit-sdk and a reachable Mubit instance:

    MUBIT_API_KEY=<key> MUBIT_ENDPOINT=http://127.0.0.1:3000 \
        uv run python examples/05_autocapture.py
"""

from __future__ import annotations

import os
import sys

from costit_client import autocapture


def main() -> None:
    api_key = os.environ.get("MUBIT_API_KEY")
    endpoint = os.environ.get("MUBIT_ENDPOINT", "http://127.0.0.1:3000")
    if not api_key:
        sys.exit("set MUBIT_API_KEY (a Mubit data-plane key) to run this example")

    # Pin learn to Costit's lane convention: costit:<namespace>. From here, your normal
    # LLM client calls are captured automatically.
    autocapture.enable(
        api_key=api_key,
        endpoint=endpoint,
        namespace="autocapture-demo",
        user_id="svc-demo",
    )
    print("autocapture enabled -> lane costit:autocapture-demo")

    try:
        # ---- your existing, unmodified LLM code would run here ----
        # e.g. an OpenAI/Anthropic/LiteLLM call. Each one is auto-ingested as a trace.
        #
        #   from anthropic import Anthropic
        #   resp = Anthropic().messages.create(model="claude-haiku-4-5", max_tokens=512,
        #                                       messages=[{"role": "user", "content": "..."}])
        #
        # For raw HTTP or an unsupported library, ingest manually instead:
        autocapture.capture(
            messages=[{"role": "user", "content": "Draft a 2-line release note for v1.2."}],
            response="v1.2 ships per-prompt model routing and faster recall. "
                     "Upgrade with `pip install -U ...`.",
            model="claude-haiku-4-5",
        )
        print("captured one interaction")

        # Close the loop with a quality signal (learn won't invent one). Either of:
        autocapture.feedback(good=True)  # or score in [-1, 1]
        print("fed back a positive signal for the most recent call")
    finally:
        autocapture.disable()  # restore original client behavior
        print("autocapture disabled")


if __name__ == "__main__":
    main()
