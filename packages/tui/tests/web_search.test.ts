import { describe, expect, test } from "bun:test";
import { parseResults } from "../src/tools/web_search.ts";

// A trimmed capture of DuckDuckGo's HTML SERP: each result is a `result__a` anchor whose href
// is a `/l/?uddg=` redirect wrapper, followed by a `result__snippet` anchor.
const SERP = `
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=abc">
    Example <b>Docs</b>
  </a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>official</b> docs for Example.</a>
</div>
<div class="result results_links">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbar.org%2Fpage%3Fq%3D1">Bar Page</a>
  <a class="result__snippet" href="#">Bar &amp; friends.</a>
</div>
`;

describe("web_search parseResults", () => {
  test("decodes uddg redirect urls and strips title/snippet markup", () => {
    const results = parseResults(SERP, 10);
    expect(results).toEqual([
      {
        title: "Example Docs",
        url: "https://example.com/docs",
        snippet: "The official docs for Example.",
      },
      { title: "Bar Page", url: "https://bar.org/page?q=1", snippet: "Bar & friends." },
    ]);
  });

  test("honours the result limit", () => {
    expect(parseResults(SERP, 1)).toHaveLength(1);
  });

  test("returns [] for a page with no result anchors", () => {
    expect(parseResults("<html><body>no results</body></html>", 5)).toEqual([]);
  });
});
