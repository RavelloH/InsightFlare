import { validateSemanticCatalog } from "./catalog";

export function assertSemanticCatalogValid(): void {
  const issues = validateSemanticCatalog();
  if (issues.length > 0) {
    throw new Error(
      `Invalid analytics semantic catalog: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
}
