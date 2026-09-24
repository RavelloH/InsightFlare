import { createContext, type ReactNode, useContext } from "react";

import type { TeamManagementClientProps } from "./types";
import type { useTeamManagement } from "./use-team-management";

export type TeamManagementViewModel = TeamManagementClientProps &
  ReturnType<typeof useTeamManagement>;

const TeamManagementContext = createContext<TeamManagementViewModel | null>(
  null,
);

export function TeamManagementProvider({
  value,
  children,
}: {
  value: TeamManagementViewModel;
  children: ReactNode;
}) {
  return (
    <TeamManagementContext.Provider value={value}>
      {children}
    </TeamManagementContext.Provider>
  );
}

export function useTeamManagementContext(): TeamManagementViewModel {
  const value = useContext(TeamManagementContext);
  if (!value) throw new Error("Team management context is not available.");
  return value;
}
