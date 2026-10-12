/**
 * Domain layer — apparel-specific data, types, and pure logic. No React,
 * no UI. Everything in this folder is consumable by the simulation engine,
 * the page components, and (later) by the project file format.
 *
 * Read order for new contributors:
 *   1. machines.ts   — what physical equipment exists
 *   2. workers.ts    — who works on it
 *   3. operations.ts — what they do, with SMVs
 *   4. garments.ts   — pre-baked operation bulletins for T-shirt / polo / shirt / trouser
 *   5. kpi.ts        — the formulas that turn run output into IE-friendly KPIs
 *   6. palette.ts    — the AnyLogic-style apparel palette catalog (UI-facing)
 *   7. iso.ts        — isometric fixture catalogue (Builder 2D + ISO views)
 *   8. stationTypes.ts / fixture-registry.ts — user-authored station types,
 *      and the lookup that resolves them and the built-in catalog together
 */

export * from './machines';
export * from './workers';
export * from './operations';
export * from './garments';
export * from './kpi';
export * from './line-balance';
export * from './balance-advisor';
export * from './palette';
export * from './iso';
export * from './station-art';
export * from './stationTypes';
export * from './fixture-registry';
export * from './camera';
