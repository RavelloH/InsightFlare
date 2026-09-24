import { TeamManagementProvider } from "./team-management/context";
import { TeamManagementPageContent } from "./team-management/page-content";
import type { TeamManagementClientProps } from "./team-management/types";
import { useTeamManagement } from "./team-management/use-team-management";

export function TeamManagementClient(props: TeamManagementClientProps) {
  const state = useTeamManagement(props);
  const value = { ...props, ...state };

  return (
    <TeamManagementProvider value={value}>
      <TeamManagementPageContent />
    </TeamManagementProvider>
  );
}
