# Packaged Edit Experiment Sample

This is a small, self-contained sample that packages a pi-lab experiment as its own npm package.
It demonstrates the JSON-only config + full-extension-bundle lane model.

## Layout

- `index.ts`: registers the extension using `createAbExtension`
- `experiments/edit-fast.json`: experiment config
- `lanes/edit/baseline.ts`: baseline lane extension
- `lanes/edit/variant-a.ts`: alternative lane extension
- `prompts/grade-edit.md`: LLM grading prompt for winner selection

## Install

From the repo root:

```bash
cd examples/packaged-edit-experiment
npm install
```

`npm install` wires the local root package via `"@marckrenn/pi-lab": "file:../.."`.

## Run

From the sample directory:

```bash
pi -e .
```

When loaded, `/ab status` should list the `edit-fast` experiment.
Use any `edit` call in PI; both lanes will be run and compared for matching calls.

## Smoke test

To verify the package end-to-end:

```bash
npm run smoke
```

The smoke script checks that:
- the package loads as a pi extension package
- `/ab status` can see `edit-fast`
- an `edit` call triggers the experiment
- a `run.json` artifact is written for `edit-fast`
