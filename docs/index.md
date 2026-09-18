---
title: specpi-jev-guard
---

A [Pi](https://pi.dev) extension that gates dangerous shell and file tool calls
with [Jev](https://openrouter.ai/~typesafe/jev-latest) — TypeSafe's fast,
decision-only classifier.

Local rules settle the obvious cases in 0 ms. Everything else gets a Jev
danger probability in a few hundred milliseconds: high danger blocks, the
middle band asks you, low danger runs. No key, no network, or a garbled
verdict never silently waves a call through — the guard fails closed.

## Install

```bash
pi install git:github.com/TannerMidd/specpi-jev-guard
```

Then run `/jev-guard setup` inside pi — it checks your key, offers a backend
switch, probes Jev live, and switches the guard on. Full docs in the
[README](https://github.com/TannerMidd/specpi-jev-guard).

## Live danger matrix

63 commands probed against Jev via OpenRouter (thresholds ask ≥ 0.35, block ≥
0.8). Green runs, amber asks, red never runs. Regenerate with `npm run matrix`.

<picture>
  <source srcset="jev-chart-dark.svg" media="(prefers-color-scheme: dark)">
  <img src="jev-chart.svg" alt="Jev danger by command, sorted low to high" width="100%">
</picture>
