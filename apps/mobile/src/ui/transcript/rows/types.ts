/**
 * Shared props for interaction-card rows. Cards build the EXACT typed
 * @codedeck/protocol command and hand it to `sendCommand` — TranscriptView
 * wires that to bridgeApi.send(machine, msg), and component tests substitute a
 * recorder to assert the exact wire payload.
 */
import type { PhoneToBridgeMessage } from '@codedeck/protocol';

export interface CardActions {
  /** Send one phone→bridge command for THIS session's machine. */
  sendCommand(msg: PhoneToBridgeMessage): void;
  /** Optimistically mark a card responded (uiStore-backed). */
  markResponded(cardId: string): void;
  /** Remember which plan option was tapped (label on the resolved card). */
  setPlanChoice(cardId: string, key: string): void;
}
