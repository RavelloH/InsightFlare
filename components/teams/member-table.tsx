"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MemberData } from "@/lib/edge-client";

interface MemberTableProps {
  members: MemberData[];
  teamId: string;
  labels: { username: string; email: string; name: string; role: string; action: string; owner: string; remove: string };
}

export function MemberTable({ members, teamId, labels }: MemberTableProps) {
  const router = useRouter();

  async function removeMember(userId: string) {
    try {
      const res = await fetch("/api/admin/member", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "remove", teamId, userId }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(labels.remove);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{labels.username}</TableHead>
          <TableHead>{labels.email}</TableHead>
          <TableHead>{labels.name}</TableHead>
          <TableHead>{labels.role}</TableHead>
          <TableHead>{labels.action}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={`${member.teamId}:${member.userId}`}>
            <TableCell className="font-medium">{member.username}</TableCell>
            <TableCell>{member.email}</TableCell>
            <TableCell>{member.name || "-"}</TableCell>
            <TableCell><Badge variant="outline">{member.role}</Badge></TableCell>
            <TableCell>
              {member.role === "owner" ? (
                <span className="text-xs text-muted-foreground">{labels.owner}</span>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => removeMember(member.userId)}>
                  {labels.remove}
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
