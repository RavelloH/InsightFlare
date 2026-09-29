import { validateSemanticCatalog } from "./catalog";
import { validateMetricCatalog } from "./metrics";

export function assertSemanticCatalogValid(): void {
  const issues = [...validateSemanticCatalog(), ...validateMetricCatalog()];
  if (issues.length) {
    throw new Error(
      `Invalid analytics semantic catalog: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
}
