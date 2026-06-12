from dataclasses import dataclass

@dataclass
class Task:
    prompt: str
    task_type: str      # "code" | "qa" | "reasoning" | "extraction" | "creative" | ...
    quality_fn: callable  # (model_output: str) -> float in [0,1]
    slider: float = 5.0   # cost-quality tradeoff: 1.0=cheapest, 10.0=best quality


TASKS = [
    Task(
        prompt="Extract order id and total from: 'Order #A-9931 totalling $48.20 shipped.'",
        task_type="extraction",
        quality_fn=lambda t: 1.0 if "A-9931" in t and "48.20" in t else 0.0,
        slider=3.0,   # cheap is fine for extraction
    ),
    Task(
        prompt="Write a retry policy with jitter for a flaky payment webhook. Justify the math.",
        task_type="reasoning",
        quality_fn=lambda t: 0.9 if len(t) > 200 else 0.4,
        slider=7.0,   # harder task, want quality
    ),
    Task(
        prompt="Implement binary search in Python with a test. Make it idiomatic.",
        task_type="code",
        quality_fn=lambda t: 1.0 if "def binary_search" in t and "assert" in t else 0.5,
        slider=5.0,
    ),
]