"""Tiny math helpers (bench validator example fixture)."""


def add(a: float, b: float) -> float:
    return a + b


def mean(values: list[float]) -> float:
    if not values:
        raise ValueError("mean of empty list")
    return sum(values) / len(values)
