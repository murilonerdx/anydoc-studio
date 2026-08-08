# ONNX Runtime Web (vendored)

Vendored subset of [`onnxruntime-web`](https://www.npmjs.com/package/onnxruntime-web) **v1.22.0**, used by the PaddleOCR engine so it runs **fully offline** (no CDN fetch on first use).

Only the WebAssembly (CPU) build is included — the WebGPU/JSEP runtime is intentionally omitted:

| File | Purpose |
| --- | --- |
| `ort.wasm.min.mjs` | ESM entry (WASM execution provider only) |
| `ort-wasm-simd-threaded.mjs` | WebAssembly loader glue |
| `ort-wasm-simd-threaded.wasm` | SIMD WebAssembly binary (tracked via Git LFS) |

**License:** MIT — Copyright (c) Microsoft Corporation. See <https://github.com/microsoft/onnxruntime/blob/main/LICENSE>.
