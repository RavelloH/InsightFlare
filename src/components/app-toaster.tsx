import { Toaster } from "@insightflare/ui/sonner";

import { useTheme } from "@/components/theme-provider";

export function AppToaster() {
  const { theme } = useTheme();

  return <Toaster theme={theme} />;
}
