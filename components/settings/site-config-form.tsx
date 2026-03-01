"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { SlidersHorizontal } from "lucide-react";
import type { SiteData } from "@/lib/edge-client";

interface SiteConfigFormProps {
  site: SiteData;
  config: Record<string, unknown>;
  labels: {
    siteConfiguration: string; siteName: string; domain: string;
    publicVisibility: string; enablePublic: string; publicSlug: string;
    privacyDefaults: string; maskQuery: string; maskTrajectory: string;
    maskReferrer: string; saveConfig: string;
  };
}

function boolFromUnknown(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "number") return input !== 0;
  if (typeof input === "string") {
    const v = input.toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  }
  return fallback;
}

export function SiteConfigForm({ site, config, labels }: SiteConfigFormProps) {
  const privacy = (config.privacy && typeof config.privacy === "object" ? config.privacy : {}) as Record<string, unknown>;
  const [publicEnabled, setPublicEnabled] = useState(Number(site.publicEnabled) === 1);
  const [maskQuery, setMaskQuery] = useState(boolFromUnknown(privacy.maskQueryHashDetails, true));
  const [maskTrajectory, setMaskTrajectory] = useState(boolFromUnknown(privacy.maskVisitorTrajectory, true));
  const [maskReferrer, setMaskReferrer] = useState(boolFromUnknown(privacy.maskDetailedReferrerUrl, true));
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/admin/site-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siteId: site.id,
          name: form.get("name"),
          domain: form.get("domain"),
          publicEnabled,
          publicSlug: form.get("publicSlug") || "",
          maskQueryHashDetails: maskQuery,
          maskVisitorTrajectory: maskTrajectory,
          maskDetailedReferrerUrl: maskReferrer,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(labels.saveConfig);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-primary" />
          {site.name} ({site.domain})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{labels.siteName}</Label>
              <Input name="name" defaultValue={site.name} required />
            </div>
            <div className="space-y-2">
              <Label>{labels.domain}</Label>
              <Input name="domain" defaultValue={site.domain} required />
            </div>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            <h3 className="font-semibold">{labels.publicVisibility}</h3>
            <div className="flex items-center gap-3">
              <Switch checked={publicEnabled} onCheckedChange={setPublicEnabled} />
              <Label>{labels.enablePublic}</Label>
            </div>
            <div className="space-y-2">
              <Label>{labels.publicSlug}</Label>
              <Input name="publicSlug" defaultValue={site.publicSlug || ""} placeholder="example-public" />
            </div>
          </div>

          <div className="rounded-lg border p-4 space-y-4">
            <h3 className="font-semibold">{labels.privacyDefaults}</h3>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Switch checked={maskQuery} onCheckedChange={setMaskQuery} />
                <Label>{labels.maskQuery}</Label>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={maskTrajectory} onCheckedChange={setMaskTrajectory} />
                <Label>{labels.maskTrajectory}</Label>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={maskReferrer} onCheckedChange={setMaskReferrer} />
                <Label>{labels.maskReferrer}</Label>
              </div>
            </div>
          </div>

          <Button type="submit" disabled={loading}>{labels.saveConfig}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
