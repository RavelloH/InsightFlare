"use client";

import type { AppMessages } from "@/lib/i18n/messages";
import type { RangePreset } from "@/lib/dashboard/query-state";

interface FilterControlsProps {
  pathname: string;
  range: RangePreset;
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

export function FilterControls({
  pathname,
  range,
  filters,
  options,
  messages,
}: FilterControlsProps) {
  void pathname;
  void range;
  void filters;
  void options;
  void messages;
  return null;
}
