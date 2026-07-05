# Agent Harness (removed in v0.7.0)

The Python agent harness that used to live at `src/minima_harness/` (a Minima-native
port of [`@earendil-works/pi`](https://github.com/earendil-works/pi)'s agent toolkit)
was **removed in v0.7.0**, along with the `minima` / `minima-harness` console scripts
that the `minima-cli` PyPI package used to install.

Its successor is the TypeScript harness + TUI in [`packages/tui/`](../packages/tui/) —
a faithful port that keeps the same loop (recommend → run → judge → feedback) and is
the shipped `minima` CLI:

```bash
brew tap mubit-ai/minima
brew install minima
```

See [`packages/tui/README.md`](../packages/tui/README.md) for architecture and usage.
The `minima-cli` PyPI package now contains only the Minima server (`minima`) and the
Python client SDK (`minima_client`).

For the historical Python implementation, see the repo history prior to v0.7.0
(e.g. `git show v0.6.0:docs/harness.md`).
