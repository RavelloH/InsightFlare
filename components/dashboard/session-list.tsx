import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock } from "lucide-react";
import { formatDateTime } from "@/lib/utils";

interface SessionListProps {
  sessions: Array<{
    sessionId: string;
    views: number;
    entryPath: string;
    exitPath: string;
    startedAt: number;
  }>;
  labels: {
    title: string;
    empty: string;
  };
}

export function SessionList({ sessions, labels }: SessionListProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-chart-3" />
          {labels.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          sessions.map((session) => (
            <div key={session.sessionId} className="rounded-lg border p-3 transition-colors hover:bg-muted/50">
              <div className="flex items-center justify-between">
                <p className="font-mono text-xs text-muted-foreground">{session.sessionId.slice(0, 16)}...</p>
                <Badge variant="outline">{session.views} views</Badge>
              </div>
              <p className="mt-1 text-sm">
                {session.entryPath || "/"} → {session.exitPath || "/"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(session.startedAt)}</p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
