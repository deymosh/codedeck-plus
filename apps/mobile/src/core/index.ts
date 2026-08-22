/**
 * The framework-free phone core (CDX-009 Phase 3a).
 *
 * Everything here runs headless in node — zustand vanilla stores + services
 * behind injected ports (KV, transport, transcript storage, timers). React
 * components (3c) and Tauri seams (3b: SQLite, real sockets, native events)
 * bind to this surface; production code in this tree NEVER imports
 * @codedeck/core or @codedeck/testkit.
 */
export * from './ports';
export * from './crypto';
export * from './services/nostrClient';
export * from './services/bridgeApi';
export * from './stores/connection';
export * from './stores/machines';
export * from './stores/transcript';
export * from './stores/outbox';
export * from './stores/identity';
export * from './stores/pairing';
export * from './stores/settings';
export * from './stores/ui';
export * from './sessionNeedsAttention';
export * from './deleteController';
export * from './createPhoneCore';
