# Ground Truth: Merge Sort Algorithm in Python

_Compiled by the planning council from the planning conversation._

## Goal

Implement a standalone recursive merge sort function in Python that returns a new sorted list in ascending order while preserving stability, suitable for a memory-constrained environment.

## Overview

The implementation provides a recursive merge sort via a public `merge_sort(array)` function that returns a new sorted list without modifying the input. A private `_merge(left, right)` helper combines two sorted sublists using `<=` comparison to ensure stability. The algorithm splits the input at the midpoint, recursively sorts both halves, and merges the results. The recursion depth is O(log n) and the space complexity is O(n), with all test cases covering edge cases including empty arrays, single elements, pre-sorted and reverse-sorted input, duplicates, and stability verification.

## Requirements

- Implement a standalone function `merge_sort(array)` that accepts a list and returns a new sorted list
- The function must be recursive, not iterative
- The sort must be stable — equal elements retain their relative order from the input
- Sort in ascending order
- Return a new list; do not modify the input array in-place
- Handle edge cases: empty arrays, single-element arrays, arrays with duplicates
- Include a private `_merge(left, right)` helper that combines two sorted sublists

## Constraints

- Language: Python (no version specified; assume Python 3.6+)
- No external dependencies; use only standard library
- Recursive implementation (as per user's memory constraint trade-off)
- Ascending order, not descending
- Non-mutating — input array must not be modified
- File locations: `src/python/merge_sort.py` for implementation, `tests/python/test_merge_sort.py` for tests

## Key Decisions

### Recursive vs. Iterative

**Decision:** Recursive implementation chosen

**Rationale:** User stated 'lack of memory therefore recursive,' indicating preference for recursive approach despite it using O(log n) stack space versus O(1) for iterative. Recursion depth for merge sort is logarithmic (~20 frames for a million elements), well within Python's default recursion limit of 1000, so stack overflow is not a practical concern.


### Return Behavior

**Decision:** Return a new sorted list without modifying the input

**Rationale:** Non-mutating design is cleaner for a standalone function and allows the caller to preserve the original list if needed.


### Stability

**Decision:** Use `<=` comparison in the merge step to preserve stability

**Rationale:** Ensures equal elements maintain their original relative order, a standard property of merge sort.


### Split Point

**Decision:** Use `len(array) // 2` to determine the midpoint

**Rationale:** Simple, standard, and avoids integer overflow concerns (not an issue in Python but good practice).


### Base Case

**Decision:** Return a shallow copy for arrays of length 0 or 1

**Rationale:** Ensures the function always returns a new list, consistent with the non-mutating contract.


### Sort Order

**Decision:** Ascending order

**Rationale:** Default and most common convention; not explicitly stated by user but is the standard assumption.


## Implementation Plan

1. Create `src/python/merge_sort.py` with two functions:
2. - Public `merge_sort(array)`: the entry point; handle empty/single-element cases; otherwise split at midpoint, recursively sort both halves, and merge the results
3. - Private `_merge(left, right)`: combine two sorted lists using two pointers, appending elements in order with `<=` for stability; append remaining elements from the longer list
4. Implement the split as `mid = len(array) // 2`, then `left_half = array[:mid]` and `right_half = array[mid:]`
5. Recursively call `merge_sort()` on both halves and merge the return values using `_merge()`
6. Create `tests/python/test_merge_sort.py` with the following test cases:
7. - Empty array → returns empty list
8. - Single-element array → returns a copy of that element
9. - Already sorted array → returns the same elements in order
10. - Reverse-sorted array → returns sorted in ascending order
11. - Array with duplicates → returns duplicates in their original relative positions
12. - Stability test → verify that equal elements with identity markers retain their original order
13. Run all tests to confirm correctness

## Risks & Edge Cases

- Recursion depth: For very large arrays (>2^20 elements), recursion depth could approach or exceed Python's default limit of 1000, causing a RecursionError. For typical use cases (up to ~1 million elements), this is not a concern.
- Memory usage: The O(n) space complexity from temporary lists during merging could be problematic in extremely memory-constrained environments. An in-place merge sort would use O(log n) extra space but is significantly more complex.
- Input validation: The function does not validate that the input is iterable or has a consistent element type; it relies on Python's duck typing and will raise exceptions if the input is not a valid sequence.
- Shallow copy behavior: If the input list contains mutable objects, those objects are shared between the input and output lists; mutations to nested objects will be visible in both.

## Success Criteria

- The `merge_sort(array)` function is importable from `src/python/merge_sort.py`
- All test cases in `tests/python/test_merge_sort.py` pass without errors
- Empty array test: `merge_sort([])` returns `[]`
- Single element test: `merge_sort([5])` returns `[5]`
- Sorted array test: `merge_sort([1, 2, 3, 4, 5])` returns `[1, 2, 3, 4, 5]`
- Reverse-sorted array test: `merge_sort([5, 4, 3, 2, 1])` returns `[1, 2, 3, 4, 5]`
- Duplicates test: `merge_sort([3, 1, 3, 1])` returns `[1, 1, 3, 3]`
- Stability test: Elements with equal sort keys maintain their original relative order
- Non-mutation test: The input array passed to `merge_sort()` is not modified
- Return value is a new list instance, not a reference to the input
