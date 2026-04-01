# Published Build Reconstruction

This folder is a local reconstruction of the published Vercel build for TryGC OPS.

What this project contains:

- The extracted static deployment under [`site/`](./site)
- A zero-dependency local preview server in [`server.mjs`](./server.mjs)
- The extraction metadata in [`extract-summary.json`](./extract-summary.json)

What this project does not contain:

- The original TypeScript or React source code
- A clean Git-tracked source branch matching the published deployment

This is useful for:

- Running the exact published build locally
- Verifying routes such as `/campaign-checklist`
- Archiving the deployed artifact outside Vercel

Run it with:

```bash
npm run preview
```

Default preview URL:

```text
http://127.0.0.1:4180
```
