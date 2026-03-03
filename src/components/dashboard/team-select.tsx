"use client";

import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TeamSelectOption {
  slug: string;
  name: string;
  href: string;
}

interface TeamSelectProps {
  options: TeamSelectOption[];
  activeTeamSlug: string;
}

export function TeamSelect({ options, activeTeamSlug }: TeamSelectProps) {
  const router = useRouter();
  if (options.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">-</p>;
  }

  const selectedSlug = options.some((option) => option.slug === activeTeamSlug)
    ? activeTeamSlug
    : options[0].slug;

  return (
    <Select
      value={selectedSlug}
      onValueChange={(value) => {
        const next = options.find((option) => option.slug === value);
        if (!next || next.slug === selectedSlug) return;
        router.push(next.href);
      }}
    >
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.slug} value={option.slug}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
