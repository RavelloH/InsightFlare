"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Calendar, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface DateRangePickerProps {
  locale: string;
  from: number;
  to: number;
}

function toDateTimeLocal(ms: number): string {
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

function formatRangeLabel(from: number, to: number): string {
  const now = Date.now();
  const diff = now - from;
  const days = Math.round(diff / (24 * 60 * 60 * 1000));
  if (days <= 7) return "Last 7 days";
  if (days <= 30) return "Last 30 days";
  if (days <= 90) return "Last 90 days";
  return `${new Date(from).toLocaleDateString()} - ${new Date(to).toLocaleDateString()}`;
}

export function DateRangePicker({ locale, from, to }: DateRangePickerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [fromValue, setFromValue] = useState(toDateTimeLocal(from));
  const [toValue, setToValue] = useState(toDateTimeLocal(to));
  const [open, setOpen] = useState(false);

  function applyRange(newFrom: number, newTo: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("fromIso", new Date(newFrom).toISOString());
    params.set("toIso", new Date(newTo).toISOString());
    router.push(`?${params.toString()}`);
    setOpen(false);
  }

  function applyPreset(days: number) {
    const now = Date.now();
    applyRange(now - days * 24 * 60 * 60 * 1000, now);
  }

  function applyCustom() {
    const f = Date.parse(fromValue);
    const t = Date.parse(toValue);
    if (Number.isFinite(f) && Number.isFinite(t)) {
      applyRange(Math.min(f, t), Math.max(f, t));
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="gap-2 h-8 text-sm">
          <Calendar className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{formatRangeLabel(from, to)}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="end">
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => applyPreset(7)}>
              7d
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => applyPreset(30)}>
              30d
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => applyPreset(90)}>
              90d
            </Button>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {locale === "zh" ? "起始时间" : "From"}
            </label>
            <input
              type="datetime-local"
              value={fromValue}
              onChange={(e) => setFromValue(e.target.value)}
              className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {locale === "zh" ? "结束时间" : "To"}
            </label>
            <input
              type="datetime-local"
              value={toValue}
              onChange={(e) => setToValue(e.target.value)}
              className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <Button onClick={applyCustom} className="w-full h-8 text-sm" size="sm">
            {locale === "zh" ? "应用" : "Apply"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
