from __future__ import annotations

from minima_harness.tools.question import QuestionOption, QuestionParams, question_tool


def test_question_tool_descriptor():
    t = question_tool()
    assert t.name == "question"
    # Sequential so a question never runs concurrently with another tool's modal.
    assert t.execution_mode == "sequential"


async def test_question_headless_proceeds():
    # ask=None (headless / --print): the tool must not block — it tells the model to proceed.
    res = await question_tool().execute("c1", QuestionParams(question="Which file?"), None, None)
    assert "proceed" in res.content[0].text.lower()
    assert res.details["answered"] is False
    assert res.details["reason"] == "headless"


async def test_question_returns_user_answer():
    captured: dict = {}

    async def ask(params):
        captured["params"] = params
        return "src/auth/login.py"

    res = await question_tool(ask).execute(
        "c1",
        QuestionParams(
            question="Which file should I fix?",
            header="auth bug",
            options=[
                QuestionOption(label="src/auth/login.py", description="password login"),
                QuestionOption(label="src/auth/oauth.py"),
            ],
        ),
        None,
        None,
    )
    assert "src/auth/login.py" in res.content[0].text
    assert res.details["answer"] == "src/auth/login.py"
    assert res.details["answered"] is True
    # The full params (question + options) reached the callback unchanged.
    assert captured["params"].question == "Which file should I fix?"
    assert len(captured["params"].options) == 2
    assert captured["params"].options[0].label == "src/auth/login.py"


async def test_question_dismissed_proceeds():
    async def ask(params):
        return None  # user pressed Esc

    res = await question_tool(ask).execute("c1", QuestionParams(question="Pick one"), None, None)
    assert "judgment" in res.content[0].text.lower()
    assert res.details["answered"] is False
    assert res.details["reason"] == "dismissed"
