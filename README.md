# HaramBlock - AI-Powered Content Filter Extension

HaramBlock is a browser extension that uses AI to detect and filter inappropriate content on web
pages using advanced computer vision models. The extension uses a MessageChannel-based architecture
for efficient image processing and provides real-time content filtering with customizable settings
per website.

## Key Features

- **AI-powered content detection** using computer vision models
- **Real-time image processing** via MessageChannel for optimal performance
- **Per-host customizable settings** with reactive database storage
- **Multiple filtering modes**: whitelist, blacklist, and intelligent processing
- **Advanced visual effects**: bounding box blur overlays and segmentation masks
- **Cross-browser compatibility** using WXT framework

## Architecture Overview

The extension uses a distributed architecture with multiple entry points:

- **Content Script** - DOM observation and real-time filtering on web pages
- **Background Service Worker** - AI model inference and prediction caching
- **MessageChannel Transport** - High-performance communication for transferables (ImageBitmap,
  ArrayBuffer)
- **Reactive Settings System** - IndexedDB storage with live updates across contexts

## Development

### Commands

- Build: `pnpm build`
- Test: `pnpm test:unit`
- Lint: `pnpm lint`

### Extension APIs

Use `browser.` instead of `chrome.` for extension APIs to ensure cross-browser compatibility.
