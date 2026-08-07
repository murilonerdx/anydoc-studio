# Credits & third-party licenses

anydoc studio is built entirely on open-source work. Every engine and library it
uses is listed below with its role and license. Vendored copies live under
`vendor/` and `models/`; a few heavy runtimes are loaded on demand from a public
CDN (noted as *CDN, on demand*).

## Core conversion & analysis

| Project | Role | License |
| --- | --- | --- |
| [firecrawl/anydoc](https://github.com/firecrawl/anydoc) | Convert 14 document formats → Markdown + a structured document model (WASM) | MIT |
| [firecrawl/pdf-inspector](https://github.com/firecrawl/pdf-inspector) | PDF classification, OCR routing, layout & encoding analysis (WASM) | MIT |
| [marked](https://github.com/markedjs/marked) | Markdown → HTML for the rendered preview | MIT |

## OCR (optical character recognition)

| Project | Role | License |
| --- | --- | --- |
| [Tesseract.js](https://github.com/naptha/tesseract.js) | In-browser OCR engine (light), vendored with its WASM core and language data | Apache-2.0 |
| [PaddleOCR (PP-OCRv5)](https://github.com/PaddlePaddle/PaddleOCR) | High-accuracy OCR models (ONNX) | Apache-2.0 |
| [paddleocr.js](https://github.com/X3ZvaWQ/paddleocr.js) | PaddleOCR ONNX runtime for the browser | MIT |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | Runs the PaddleOCR models — *CDN, on demand* | MIT |
| [PDF.js](https://github.com/mozilla/pdf.js) | Rasterises PDF pages for OCR (vendored) | Apache-2.0 |
| [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) | Tesseract language models (eng, por, spa, fra, deu, ita) | Apache-2.0 |

## Translation

| Project | Role | License |
| --- | --- | --- |
| [Bergamot Translator](https://github.com/browsermt/bergamot-translator) | Neural machine translation fully in the browser (WASM) | MPL-2.0 |
| [Firefox Translations Models](https://github.com/mozilla/firefox-translations-models) | Language models for Bergamot (downloaded on demand) | Various OSS |
| [Ollama](https://github.com/ollama/ollama) | Optional local LLM server for translation | MIT |
| [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) | Optional self-hosted translation API | AGPL-3.0 (used as an external service only) |
| [franc](https://github.com/wooorm/franc) | Source-language detection | MIT |

## Scraping

| Project | Role | License |
| --- | --- | --- |
| [@mozilla/readability](https://github.com/mozilla/readability) | Extract the main article from an HTML page | Apache-2.0 |
| [Turndown](https://github.com/mixmark-io/turndown) | HTML → Markdown conversion | MIT |

## Fonts

| Asset | License |
| --- | --- |
| Geist Mono | OFL-1.1 |
| Suisse Intl (as shipped by the anydoc demo assets) | see anydoc |

## Research & inspiration

The layout-preserving translation design follows the approach of
[BabelDOC](https://github.com/funstory-ai/BabelDOC) and
[PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate). Document-analysis
directions were informed by [MinerU](https://github.com/opendatalab/MinerU),
[RAGFlow](https://github.com/infiniflow/ragflow),
[EasyOCR](https://github.com/JaidedAI/EasyOCR), and
[opendataloader-pdf](https://github.com/opendataloader-project/opendataloader-pdf).

> LibreTranslate is AGPL-3.0. anydoc studio only *talks to* a LibreTranslate
> server over HTTP (it does not bundle or link its code), so it is used as an
> independent external service.
