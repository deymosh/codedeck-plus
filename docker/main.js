import WebSocket from 'ws';
globalThis.WebSocket = WebSocket;

// The image deploys apps/bridge as the /app package root (pnpm deploy), so
// the bundle sits at /app/out/main.js next to this shim.
await import('./out/main.js');
