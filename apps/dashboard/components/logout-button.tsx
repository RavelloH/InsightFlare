import { Button } from "@/components/ui/button";

export function LogoutButton(): React.JSX.Element {
  return (
    <form action="/api/auth/logout" method="POST">
      <Button variant="secondary" type="submit">
        Sign out
      </Button>
    </form>
  );
}

