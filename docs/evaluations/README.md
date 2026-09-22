# Recorded evaluation archive

This is a **documentation-only snapshot** of the Jev/Laya comparison and follow-up
experiments, recorded 2026-09-22. The Laya implementation is shelved, not an option
in the released package. No backend, dependency, threshold, package setting or
benchmark runner is changed by this branch.

- [Browse the evidence](index.html)
- [Matched API/CPU/GPU results](results/README.md)
- [Expanded 856-attempt suite](results/devious-v2/README.md)
- [Six-configuration tuning study](results/laya-study/README.md)
- [Frozen study protocol](study/protocol.md)

## What is preserved

`results/` contains the original JSON observations, resource snapshots, selection
and validation records. `study/` contains the frozen protocol, questions and
48 authored contrast inputs. `charts/` contains static SVG/HTML exports. The raw
JSON and frozen study inputs are byte-identical to the research recordings;
`checksums.json` records their SHA-256 hashes. Narrative reports and share-card
wording were adapted to make the shelved status clear, without changing numbers.

The old manifests intentionally retain paths and source hashes from the experiment.
They describe provenance, not files available in this documentation-only branch.
The runtime, study/expanded runners, Python environments and raw mixed-license
external dataset are not included. Re-running inference requires the shelved
research implementation; this archive does not claim stand-alone reproducibility.
The authored expanded commands remain inert text in the JSON records.

## Separate datasets, limited claims

- Original comparison: matched cases, local rules, questions and thresholds across
  Jev API, Laya CPU FP32 and Laya GPU BF16. Precision differs; this is not a
  device-only numerical comparison. Warm timing excludes loading.
- Expanded suite: 856 attempts, including 120 new attack/benign pairs across 20
  families, each in three correlated views. Jev API and unchanged Laya GPU only;
  **no expanded CPU run**. Greater breadth does not prove greater difficulty.
- Tuning: six predeclared configurations on 505 TRAIN cases. No candidate passed
  the gate. Baseline and one frozen, diagnostic FP32 candidate were tested on
  4,193 external TEST cases, plus 48 authored contrasts. Source-derived labels,
  same-source splits and authored checks are not a safety certification.
- Errors remain separate, not credited as model detections. Study benign
  interruptions include fail-closed input errors. E2E assertion counts are not
  safety accuracy; agent deviations and unexercised cases remain visible.

## Local maintenance

From the repository root, with Node installed:

```sh
node docs/evaluations/verify.mjs
```

This checks archived hashes, matched inputs, headline counts, local site/report
links and sharing captions without executing commands from the dataset or calling
any model. To re-rasterize the exported SVG cards (ImageMagick required):

```sh
node docs/evaluations/rasterize.mjs
```

All cards remain light-theme, opaque 1600×900 PNGs. The website's inline SVGs retain
theme support. These are frozen research exports; the original project chart
commands still manage their original Jev recordings, not the archived experiments.
