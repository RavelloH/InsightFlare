"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RiArrowRightLine } from "@remixicon/react";
import type { TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import { navigateWithTransition } from "@/lib/page-transition";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

interface PostLoginTeamPickerCardProps {
  locale: Locale;
  teams: TeamData[];
  title: string;
  description: string;
  loadingLabel: string;
}

export function PostLoginTeamPickerCard({
  locale,
  teams,
  title,
  description,
  loadingLabel,
}: PostLoginTeamPickerCardProps) {
  const router = useRouter();
  const [pendingTeamSlug, setPendingTeamSlug] = useState<string | null>(null);

  function handleSelect(teamSlug: string) {
    if (pendingTeamSlug) return;
    setPendingTeamSlug(teamSlug);
    navigateWithTransition(router, `/${locale}/app/${teamSlug}`);
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {teams.map((team) => {
          const pending = pendingTeamSlug === team.slug;

          return (
            <Button
              key={team.id}
              type="button"
              variant="outline"
              className="w-full justify-between"
              disabled={pendingTeamSlug !== null}
              onClick={() => {
                handleSelect(team.slug);
              }}
            >
              <AutoTransition className="inline-flex w-full items-center justify-between gap-2">
                {pending ? (
                  <span key={`pending-${team.id}`} className="inline-flex items-center gap-2">
                    <Spinner className="size-4" />
                    {loadingLabel}
                  </span>
                ) : (
                  <span
                    key={`idle-${team.id}`}
                    className="inline-flex w-full items-center justify-between gap-2"
                  >
                    <span className="truncate">{team.name}</span>
                    <RiArrowRightLine className="size-4 shrink-0" />
                  </span>
                )}
              </AutoTransition>
            </Button>
          );
        })}
      </CardContent>
    </Card>
  );
}
