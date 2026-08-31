// ═══════════════════════════════════════════════════════════════════════
//  @kaizen/runtime — root exports
//
//  This package extends the existing kaizen-app with a continuously
//  autonomous execution layer. See ARCHITECTURE.md for the full picture.
//
//  Fases:
//    0. Skeleton (this)             — interfaces + stubs
//    1. Multi-turn ReAct loop       — agent/*
//    2. Continuous heartbeat        — heartbeat/*
//    3. Self-modification           — self-mod/*
//    4. Spawn + lineage             — spawn/*
//    5. On-chain identity           — registry/*
//    6. Autonomous payments         — payments/*
//    7. Integration + prod deploy
// ═══════════════════════════════════════════════════════════════════════

export * from "./agent/index.js";
export * from "./heartbeat/index.js";
export * from "./self-mod/index.js";
export * from "./spawn/index.js";
export * from "./registry/index.js";
export * from "./payments/index.js";
// C.1 multi-provider LLM router + tier-aware selector
export * from "./inference/index.js";
// C.2 dynamic skills loader
export * from "./skills/index.js";
// C.3 SOUL.md self-authored identity
export * from "./identity/soul.js";
// Improvement.1 outcome tracking (Kaizen loop)
export * from "./improvement/index.js";
export * from "./improvement/versioning.js";
export * from "./improvement/shadow.js";
export * from "./types.js";
export * from "./economic/index.js";
