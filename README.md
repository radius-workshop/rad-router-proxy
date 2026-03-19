# RadRouter x402 Proxy

A local proxy that sits between your AI-powered IDE (Claude Code, Zed, Cursor, etc.) and [RadRouter](https://rad-router.eriksreks.workers.dev). It automatically handles x402 payments on the Radius Network using your local private key — no API keys needed.

## Quick start

```bash
git clone <repo-url> rad-router-proxy
cd rad-router-proxy
npm install
cp .env.example .env
# Edit .env and add your Radius wallet private key
npm start
```

Then point your IDE's API base URL to:

```
http://localhost:4020/v1
```

## How it works

1. Your IDE sends a request to the proxy (Chat Completions, Anthropic Messages, or Responses API format).
2. The proxy normalizes the request and forwards it to RadRouter.
3. If RadRouter returns HTTP 402, the proxy automatically signs an EIP-2612 permit for SBC payment and retries.
4. The response is translated back to your IDE's expected format and streamed through.

## Configuration

All configuration is via environment variables (set in `.env` or your shell):

| Variable | Required | Default | Description |
|---|---|---|---|
| `RADROUTER_PROXY_PRIVATE_KEY` | Yes* | — | Your Radius wallet private key (`0x` + 64 hex chars) |
| `RADROUTER_PROXY_PRIVATE_KEY_FILE` | — | — | Path to a file containing your private key |
| `RADROUTER_URL` | — | `https://rad-router.eriksreks.workers.dev` | RadRouter backend URL |
| `RADROUTER_PROXY_PORT` | — | `4020` | Local proxy port |
| `RADROUTER_X402_SCHEME` | — | `exact` | Payment scheme: `exact` or `upto` |
| `RADROUTER_MODEL_MAP` | — | — | JSON object to override model name mappings |
| `RADROUTER_STREAM_TIMEOUT_MS` | — | auto | Stream idle timeout in milliseconds |
| `RADROUTER_DEBUG_PAYLOAD_CAPTURE` | — | — | Set to `1` for verbose payload logging |

*If no private key is provided via env vars, the proxy will prompt interactively.

## IDE setup examples

### Claude Code

```bash
claude config set --global apiBaseUrl http://localhost:4020/v1
```

### Zed

In your Zed settings, set the API base URL to `http://localhost:4020/v1`.

### Cursor / Continue / Other OpenAI-compatible

Set the base URL to `http://localhost:4020/v1` and use any string as the API key (the proxy handles auth via x402).

## Supported API formats

The proxy accepts and translates:

- **OpenAI Chat Completions** (`/v1/chat/completions`) → normalized to Responses API
- **Anthropic Messages** (`/v1/messages`) → normalized to Responses API
- **OpenAI Responses** (`/v1/responses`) → passed through directly

Streaming is fully supported for all formats.

## Project structure

```
rad-router-proxy/
├── proxy.ts          # The proxy server (single file)
├── package.json
├── tsconfig.json
├── .env.example      # Template for environment variables
├── .gitignore
└── README.md
```
