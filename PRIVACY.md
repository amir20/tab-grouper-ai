# Privacy Policy

**Gruper** — Last updated: March 28, 2026

## What data Gruper accesses

Gruper reads the **title** and **URL** of your open browser tabs in the current window. This is the only browser data the extension accesses. It does not read tab content, browsing history, cookies, bookmarks, or any other personal data.

## Local model (default)

When using a local AI model, all tab data is processed entirely on your device using WebGPU. No tab information is transmitted to any server. The only network request made is a one-time download of model weights from HuggingFace, which are then cached locally in your browser.

## Cloud model (OpenRouter)

When you opt in to using OpenRouter as your AI provider, tab titles and URLs are sent to the OpenRouter API (`openrouter.ai`) to generate grouping suggestions. No other data is sent. Your OpenRouter API key is stored locally in your browser using `chrome.storage.local` and is never shared with anyone other than OpenRouter's API.

Refer to [OpenRouter's privacy policy](https://openrouter.ai/privacy) for how they handle data sent to their API.

## Data storage

Gruper stores the following in your browser's local storage (`chrome.storage.local`):

- Selected AI provider (local or OpenRouter)
- Selected model ID
- OpenRouter API key (if provided by the user)

This data stays on your device and is never transmitted to us or any third party.

## Data collection

Gruper does not collect, store, or transmit any user data. There are no analytics, no telemetry, no tracking, and no ads.

## Third-party services

| Service | When used | What is sent |
|---------|-----------|--------------|
| HuggingFace (`huggingface.co`) | First use of a local model | Standard HTTP request to download model files (no user data) |
| OpenRouter (`openrouter.ai`) | Only when user opts in | Tab titles, URLs, and API key |

## Changes to this policy

If this policy changes, the updated version will be published in the extension's GitHub repository.

## Contact

For questions about this privacy policy, open an issue at [github.com/amir20/gruper](https://github.com/amir20/gruper).
