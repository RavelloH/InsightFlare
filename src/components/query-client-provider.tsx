import { type ReactNode, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 5 * 60 * 1000,
        staleTime: 15 * 1000,
        retry: 1,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

export function getBrowserQueryClient(): QueryClient {
  if (typeof window === "undefined")
    throw new Error("Browser query client unavailable");
  browserQueryClient ??= createQueryClient();
  return browserQueryClient;
}
function getQueryClient(): QueryClient {
  return typeof window === "undefined"
    ? createQueryClient()
    : getBrowserQueryClient();
}

export function AppQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(getQueryClient);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
