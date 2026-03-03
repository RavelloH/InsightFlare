"use client";

import { useMemo, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AppMessages } from "@/lib/i18n/messages";

const ALL_VALUE = "__all__";

type FilterKey = "country" | "device" | "browser" | "eventType";

interface FilterControlsProps {
  pathname: string;
  range: "24h" | "7d" | "30d" | "90d";
  filters: {
    country?: string;
    device?: string;
    browser?: string;
    eventType?: string;
  };
  options: {
    countries: string[];
    devices: string[];
    browsers: string[];
    eventTypes: string[];
  };
  messages: AppMessages;
}

function clampOption(value: string): string {
  return value.trim().slice(0, 120);
}

export function FilterControls({
  pathname,
  range,
  filters,
  options,
  messages,
}: FilterControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const safeFilters = useMemo(
    () => ({
      country: filters.country ? clampOption(filters.country) : undefined,
      device: filters.device ? clampOption(filters.device) : undefined,
      browser: filters.browser ? clampOption(filters.browser) : undefined,
      eventType: filters.eventType ? clampOption(filters.eventType) : undefined,
    }),
    [filters],
  );

  const navigateWith = (nextFilters: {
    country?: string;
    device?: string;
    browser?: string;
    eventType?: string;
  }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", range);

    if (nextFilters.country) params.set("country", nextFilters.country);
    else params.delete("country");

    if (nextFilters.device) params.set("device", nextFilters.device);
    else params.delete("device");

    if (nextFilters.browser) params.set("browser", nextFilters.browser);
    else params.delete("browser");

    if (nextFilters.eventType) params.set("eventType", nextFilters.eventType);
    else params.delete("eventType");

    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  const onChange = (key: FilterKey, value: string) => {
    const next = {
      ...safeFilters,
      [key]: value === ALL_VALUE ? undefined : clampOption(value),
    };
    navigateWith(next);
  };

  const clearFilters = () => {
    navigateWith({});
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={safeFilters.country || ALL_VALUE}
        onValueChange={(value) => onChange("country", value)}
      >
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder={messages.filters.country} />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={ALL_VALUE}>{messages.filters.all}</SelectItem>
          {options.countries.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={safeFilters.device || ALL_VALUE}
        onValueChange={(value) => onChange("device", value)}
      >
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder={messages.filters.device} />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={ALL_VALUE}>{messages.filters.all}</SelectItem>
          {options.devices.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={safeFilters.browser || ALL_VALUE}
        onValueChange={(value) => onChange("browser", value)}
      >
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder={messages.filters.browser} />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={ALL_VALUE}>{messages.filters.all}</SelectItem>
          {options.browsers.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={safeFilters.eventType || ALL_VALUE}
        onValueChange={(value) => onChange("eventType", value)}
      >
        <SelectTrigger className="w-[140px]">
          <SelectValue placeholder={messages.filters.eventType} />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={ALL_VALUE}>{messages.filters.all}</SelectItem>
          {options.eventTypes.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button variant="outline" size="sm" onClick={clearFilters}>
        {messages.filters.clear}
      </Button>
    </div>
  );
}
