"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { RiAddLine } from "@remixicon/react";
import type { TeamData } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TeamSelectOption {
  slug: string;
  name: string;
  href: string;
}

interface TeamSelectProps {
  locale: Locale;
  options: TeamSelectOption[];
  activeTeamSlug: string;
}

interface CreateTeamResponse {
  ok: boolean;
  data?: TeamData;
  error?: string;
  message?: string;
}

function getCopy(locale: Locale) {
  if (locale === "zh") {
    return {
      team: "团队",
      createTeam: "新建团队",
      createTeamDesc: "创建后会自动切换到新团队。",
      teamName: "团队名称",
      teamNamePlaceholder: "例如：增长团队",
      teamSlug: "团队 Slug（可选）",
      teamSlugPlaceholder: "例如：growth-team",
      cancel: "取消",
      create: "创建",
      creating: "创建中...",
      invalidTeamName: "团队名称至少 2 个字符。",
      createFailed: "创建失败，请稍后重试。",
      createHint: "新建团队",
    };
  }

  return {
    team: "Team",
    createTeam: "Create Team",
    createTeamDesc: "You will be switched to the new team after creation.",
    teamName: "Team Name",
    teamNamePlaceholder: "e.g. Growth Team",
    teamSlug: "Team Slug (optional)",
    teamSlugPlaceholder: "e.g. growth-team",
    cancel: "Cancel",
    create: "Create",
    creating: "Creating...",
    invalidTeamName: "Team name must be at least 2 characters.",
    createFailed: "Failed to create team. Please try again.",
    createHint: "Create team",
  };
}

const CREATE_TEAM_VALUE = "__create_team__";

export function TeamSelect({ locale, options, activeTeamSlug }: TeamSelectProps) {
  const router = useRouter();
  const copy = getCopy(locale);
  const [openCreateDialog, setOpenCreateDialog] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamSlug, setTeamSlug] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectedSlug = useMemo(
    () =>
      options.some((option) => option.slug === activeTeamSlug)
        ? activeTeamSlug
        : options[0]?.slug || "",
    [options, activeTeamSlug],
  );

  async function handleCreateTeam() {
    if (submitting) return;
    const normalizedName = teamName.trim();
    const normalizedSlug = teamSlug.trim();
    if (normalizedName.length < 2) {
      setSubmitError(copy.invalidTeamName);
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    try {
      const response = await fetch("/api/admin/team", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          name: normalizedName,
          slug: normalizedSlug || undefined,
        }),
      });
      const payload = (await response.json()) as CreateTeamResponse;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.message || payload.error || "create_team_failed");
      }
      setOpenCreateDialog(false);
      setTeamName("");
      setTeamSlug("");
      router.push(`/${locale}/app/${payload.data.slug}`);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : copy.createFailed;
      setSubmitError(message || copy.createFailed);
    } finally {
      setSubmitting(false);
    }
  }

  const createTeamDialog = (
    <Dialog
      open={openCreateDialog}
      onOpenChange={(next) => {
        if (!next && submitting) return;
        setOpenCreateDialog(next);
        if (!next) {
          setSubmitError("");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.createTeam}</DialogTitle>
          <DialogDescription>{copy.createTeamDesc}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreateTeam();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="create-team-name">{copy.teamName}</Label>
            <Input
              id="create-team-name"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              placeholder={copy.teamNamePlaceholder}
              minLength={2}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="create-team-slug">{copy.teamSlug}</Label>
            <Input
              id="create-team-slug"
              value={teamSlug}
              onChange={(event) => setTeamSlug(event.target.value)}
              placeholder={copy.teamSlugPlaceholder}
            />
          </div>
          {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpenCreateDialog(false)}
              disabled={submitting}
            >
              {copy.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? copy.creating : copy.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  if (options.length === 0) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start"
          onClick={() => {
            setTeamName("");
            setTeamSlug("");
            setSubmitError("");
            setOpenCreateDialog(true);
          }}
        >
          <RiAddLine />
          <span>{copy.createHint}</span>
        </Button>
        {createTeamDialog}
      </>
    );
  }

  return (
    <>
      <Select
        value={selectedSlug}
        onValueChange={(value) => {
          if (value === CREATE_TEAM_VALUE) {
            setTeamName("");
            setTeamSlug("");
            setSubmitError("");
            setOpenCreateDialog(true);
            return;
          }
          const next = options.find((option) => option.slug === value);
          if (!next || next.slug === selectedSlug) return;
          router.push(next.href);
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>{copy.team}</SelectLabel>
            {options.map((option) => (
              <SelectItem key={option.slug} value={option.slug}>
                {option.name}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value={CREATE_TEAM_VALUE}>
            <RiAddLine />
            {copy.createHint}
          </SelectItem>
        </SelectContent>
      </Select>
      {createTeamDialog}
    </>
  );
}
