# Refinish

![WIP](https://img.shields.io/badge/status-WIP-yellow)

Lightweight image compression and conversion for Mac, Linux, and Windows.

Refinish is a cross-platform desktop app for compressing and converting images. It supports modern formats, offers a non-destructive workflow, and keeps things simple.

## Planned Features

- Drag-and-drop image compression
- Quality slider with before/after preview
- Format conversion (JPEG/PNG to WebP/AVIF)
- Batch processing with progress indicator
- Selective metadata stripping
- 2x upscaling via ESPCN (planned)

## Tech Stack

- [Tauri 2](https://tauri.app) — native desktop shell
- [React](https://react.dev) — UI framework
- [Rust](https://www.rust-lang.org) — backend processing
- Sharp / image-rs — image manipulation

## Development

### Prerequisites

- [Node.js](https://nodejs.org) (v18+)
- [Rust](https://www.rust-lang.org/tools/install)

### Getting Started

```bash
npm install
npm run tauri dev
```

## License

[MIT](LICENSE)

---

[refini.sh](https://refini.sh)
