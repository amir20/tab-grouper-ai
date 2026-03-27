// src/service-worker.js
//
// This service worker hosts the WebLLM inference engine.
// The popup communicates with it via Chrome's service worker messaging.
// The model is loaded once and stays warm between popup sessions.

import { ServiceWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

// Handler must be created at top level — Chrome requires message listeners
// to be registered during initial script evaluation.
const handler = new ServiceWorkerMLCEngineHandler();

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
  console.log("[TabGrouperAI] Service worker activated");
});

self.addEventListener("message", (event) => {
  handler.onmessage(event);
});
