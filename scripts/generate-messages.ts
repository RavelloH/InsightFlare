import process from "node:process";

import { regenerateAppMessages } from "./i18n-check/prune";

regenerateAppMessages().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
