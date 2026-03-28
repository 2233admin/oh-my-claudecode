/**
 * OMC HUD - Turn Count Element
 *
 * Renders the number of completed assistant turns in the current session.
 */

import { dim } from '../colors.js';

/**
 * Render turn count.
 *
 * Format: turn:12
 */
export function renderTurnCount(turnCount: number): string | null {
  if (turnCount <= 0) return null;
  return `${dim('turn:')}${turnCount}`;
}
