/**
 * OMC HUD - Token Speed Element
 *
 * Renders the token output speed (tokens/second) for the last assistant response.
 * Calculated as: outputTokens / elapsed_seconds (from promptTime to lastAssistantTimestamp).
 */

import { dim } from '../colors.js';

/**
 * Render token output speed.
 *
 * Format: ⚡23tok/s
 */
export function renderTokenSpeed(tokenSpeed: number | null): string | null {
  if (tokenSpeed === null || tokenSpeed <= 0) return null;
  const rounded = Math.round(tokenSpeed);
  return `${dim('⚡')}${rounded}tok/s`;
}
