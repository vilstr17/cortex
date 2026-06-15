/**
 * Build-time constants injected by esbuild's `define`.
 *
 * INCLUDE_FOCUS — true in the full edition (root `main.js`, sideloaded),
 * false in the catalog edition (`dist-catalog/`, submitted to the Obsidian
 * community store). When false, esbuild dead-code-eliminates every guarded
 * focus branch and the stub plugin replaces the focus module tree with
 * empty classes so the core bundle has zero focus code, zero settings
 * residue, and zero dashboard panels.
 *
 * INCLUDE_BLE is kept for the transition; once source uses INCLUDE_FOCUS
 * everywhere it can be removed.
 */
declare const INCLUDE_FOCUS: boolean;
declare const INCLUDE_BLE: boolean;
