"use client";

import Link from "next/link";
import { RiArrowRightLine } from "@remixicon/react";
import type { TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PostLoginTeamPickerDialogProps {
  locale: Locale;
  teams: TeamData[];
  messages: AppMessages;
}

export function PostLoginTeamPickerDialog({
  locale,
  teams,
  messages,
}: PostLoginTeamPickerDialogProps) {
  const t = messages.teamEntry;

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {teams.map((team) => (
            <Button key={team.id} asChild variant="outline" className="w-full justify-between">
              <Link href={`/${locale}/app/${team.slug}`}>
                <span className="truncate">{team.name}</span>
                <RiArrowRightLine className="size-4" />
              </Link>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

