/* c8 ignore file -- this module is an intentional transport-level re-export. */

/**
 * Demo data source provider. The existing generator remains the fixture
 * implementation, while protocol adapters select it through this named
 * provider boundary alongside D1/rollup providers.
 */
export type { DemoQueryRuntimeInput as MockQueryProviderInput } from "./demo-query";
export { executeDemoQuery as executeMockQuery } from "./demo-query";
