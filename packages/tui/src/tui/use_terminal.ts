/**
 * Terminal + render plumbing hooks lifted out of app.tsx.
 *
 * Extraction only — the bodies are the effects that used to live inline in HarnessApp,
 * unchanged. Each owns the state it drives, so the component reads them as values.
 */

import { useEffect, useRef, useState } from "react";
import { perfEnabled, perfSample, perfSpawns } from "./perf.ts";
import { setResumeCallback } from "./suspend.ts";

/** Terminal sizing (rows/cols), kept in step with SIGWINCH. */
export function useTerminalSize(): { rows: number; cols: number } {
  const [rows, setRows] = useState(process.stdout.rows || 24);
  const [cols, setCols] = useState(process.stdout.columns || 80);
  useEffect(() => {
    const handleResize = () => {
      setRows(process.stdout.rows || 24);
      setCols(process.stdout.columns || 80);
    };
    process.stdout.on("resize", handleResize);

    // Mouse tracking stays OFF so native scroll/select/copy work with <Static>.
    process.stdout.write("\u001b[?1000l");
    process.stdout.write("\u001b[?1006l");

    return () => {
      process.stdout.off("resize", handleResize);
      process.stdout.write("\u001b[?1006l");
      process.stdout.write("\u001b[?1000l");
    };
  }, []);
  return { rows, cols };
}

/**
 * Ctrl+Z resume: SIGCONT bumps a nonce; the commit repaints the live region the
 * shell drew over.
 */
export function useResumeRepaint(): void {
  const [, setResumeGen] = useState(0);
  useEffect(() => {
    setResumeCallback(() => setResumeGen((n) => n + 1));
    return () => setResumeCallback(null);
  }, []);
}

/**
 * Whole-render wall time + subprocess count, sampled once per commit (the dep-less effect
 * is intentional). ms spans render body → post-commit, so any synchronous blocking inside
 * render (the per-render git fork bug) shows up here even when window compute stays fast.
 *
 * Called from the render body — the counter bump and the t0 read must happen there, not in
 * an effect, or the span would miss the render itself.
 */
export function useRenderPerf(): void {
  const renderCountRef = useRef(0);
  renderCountRef.current++;
  const renderT0 = perfEnabled ? performance.now() : 0;
  useEffect(() => {
    if (!perfEnabled) return;
    perfSample({
      kind: "render",
      ms: performance.now() - renderT0,
      renders: renderCountRef.current,
      spawns: perfSpawns(),
      stdinListeners: process.stdin.listenerCount("readable"),
    });
  });
}
