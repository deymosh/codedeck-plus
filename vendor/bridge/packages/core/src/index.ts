/**
 * @codedeck/core — headless bridge engine.
 *
 * Phase 2a: host interface + the Nostr transport layer
 * (nostr/{crypto,pool,publisher,ingest}).
 * Phase 2b: session persistence — session/{registry,transcript} + sync/server.
 * Phase 2c: SDK isolation — sdk/{facade,adapter} + session/permissions.
 * Phase 2d: session/runner + workspace/folders + the BridgeCore orchestrator
 * wiring it all together.
 */
export * from './host';
export * from './process/guards';
export * from './nostr/crypto';
export * from './nostr/pool';
export * from './nostr/publisher';
export * from './nostr/ingest';
export * from './session/transcript';
export * from './session/registry';
export * from './session/permissions';
export * from './session/runner';
export * from './sync/server';
export * from './sdk/facade';
export * from './sdk/adapter';
export * from './sdk/usage';
export * from './workspace/folders';
export * from './workspace/gsdState';
export * from './images';
export * from './mesh/meshAdmin';
export * from './mesh/deviceActions';
export * from './mesh/deviceMcp';
export * from './mesh/screenshotDelivery';
export * from './relayAdmin';
export * from './pairing';
export * from './bridge';
