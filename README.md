![License](https://img.shields.io/badge/license-BSL%201.1-blue)
![Status](https://img.shields.io/badge/status-pre--release-orange)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

![OrqaStudio](https://github.com/orqastudio/orqastudio-brand/blob/main/assets/banners/banner-1680x240.png?raw=1)

# Claude Integration

OrqaStudio plugin that provides the Claude Agent SDK sidecar, enabling the app to use Claude as its AI provider. Handles streaming conversations, tool execution, and model management through the sidecar process.

## What It Does

- Spawns and manages a Claude Agent SDK sidecar process
- Streams conversation tokens from the sidecar to the app via NDJSON
- Provides hooks for governance enforcement during tool execution
- Manages model selection and provider configuration

## Installation

Installed during project setup when Claude is selected as the AI provider.

## License

BSL-1.1 — see [LICENSE](LICENSE) for details.
