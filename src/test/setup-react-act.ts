// React 19's act() requires the testing runtime to explicitly opt in.
// Apply this only to the browser/DOM Vitest project, never production code.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
