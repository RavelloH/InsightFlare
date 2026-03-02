"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SiteData } from "@/lib/edge-client";

interface SiteSelectorProps {
  sites: SiteData[];
  currentSiteId: string;
}

export function SiteSelector({ sites, currentSiteId }: SiteSelectorProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(v: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("siteId", v);
    router.push(`?${params.toString()}`);
  }

  return (
    <Select value={currentSiteId} onValueChange={handleChange}>
      <SelectTrigger className="w-[240px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {sites.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name} ({s.domain})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
