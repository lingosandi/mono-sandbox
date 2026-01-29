/**
 * Application Configuration
 * Centralized constants and environment variables
 */

// ==========================================
// Terminal Configuration
// ==========================================
export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24
// Computed min-width for terminal: 80 cols * 8px (char width at fontSize 13) + 16px (pl-4 padding)
export const TERMINAL_MIN_WIDTH = DEFAULT_TERMINAL_COLS * 8 + 16
