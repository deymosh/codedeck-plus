/**
 * @codedeck/testkit — shared test infrastructure for contract tests.
 *
 * Phase 1: the in-memory relay. Phase 2: the fake SDK facade. CDX-008: the
 * scriptable phone simulator + in-memory relay pool + manual timers that
 * together drive @codedeck/core end-to-end at the protocol level.
 */
export * from './inMemoryRelay';
export * from './fakeSdk';
export * from './manualTimers';
export * from './relayPool';
export * from './phoneSimulator';
