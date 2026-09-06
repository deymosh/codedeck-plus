import WebSocket from 'ws';
globalThis.WebSocket = WebSocket;

// Import directly from the built CLI location inside the monorepo workspace
await import('./apps/bridge/out/main.js');