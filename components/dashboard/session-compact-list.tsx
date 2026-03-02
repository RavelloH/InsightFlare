"use client";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";

interface SessionCompactListProps {
  sessions: Array<{
    sessionId: string;
    views: number;
    entryPath: string;
    exitPath: string;
    startedAt: number;
  }>;
  emptyLabel?: string;
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionCompactList({ sessions, emptyLabel = "No sessions" }: SessionCompactListProps) {
  if (sessions.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="divide-y divide-border">
      {sessions.map((session) => (
        <div key={session.sessionId} className="flex items-center gap-3 px-4 py-2.5 hover:bg-def-100 transition-colors">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
            <span className="truncate">{session.entryPath || "/"}</span>
            <span className="shrink-0 text-muted-foreground">→</span>
            <span className="truncate text-muted-foreground">{session.exitPath || "/"}</span>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(session.startedAt)}</span>
          <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0 h-5">
            {session.views}
          </Badge>
        </div>
      ))}
    </div>
  );
}
