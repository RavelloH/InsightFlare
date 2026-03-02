import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RiTimeLine as Clock } from "@remixicon/react";
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
          <span className="bg-def-200 rounded-lg p-1 inline-flex">
            <Clock className="h-4 w-4" />
          </span>
          {labels.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">{labels.empty}</p>
        ) : (
          sessions.map((session) => (
            <div key={session.sessionId} className="rounded-md border p-2 transition-colors hover:bg-muted/50">
              <div className="flex items-center justify-between">
                <p className="font-mono text-xs text-muted-foreground">{session.sessionId.slice(0, 16)}...</p>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5">{session.views} views</Badge>
              </div>
              <p className="mt-0.5 text-xs">
                {session.entryPath || "/"} → {session.exitPath || "/"}
              </p>
              <p className="mt-0.5 text-muted-foreground text-[11px]">{formatDateTime(session.startedAt)}</p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
