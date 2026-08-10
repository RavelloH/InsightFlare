// The single E2E entry intentionally imports one ordered scenario graph.
// Keep cross-scenario state and ordering in that graph rather than relying on
// Playwright's file scheduling semantics.
import "./scenarios/complete-flow";
