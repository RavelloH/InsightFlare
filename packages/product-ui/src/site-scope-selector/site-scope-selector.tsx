import { Button } from "@insightflare/ui/button";
import { RiCheckboxBlankCircleLine, RiCheckLine } from "@remixicon/react";

import { cn } from "../utils/cn";

export interface SiteScopeOption {
  id: string;
  name?: string;
  domain?: string;
}

export interface SiteScopeSelectorProps {
  /** An empty list represents access to all sites. */
  selectedSiteIds: readonly string[];
  sites: readonly SiteScopeOption[];
  allSitesLabel: string;
  emptySitesLabel?: string;
  ariaLabel: string;
  onChange: (selectedSiteIds: string[]) => void;
  className?: string;
}

export function SiteScopeSelector({
  selectedSiteIds,
  sites,
  allSitesLabel,
  emptySitesLabel,
  ariaLabel,
  onChange,
  className,
}: SiteScopeSelectorProps) {
  const allSitesSelected = selectedSiteIds.length === 0;

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("flex flex-wrap gap-2", className)}
    >
      <Button
        type="button"
        variant={allSitesSelected ? "default" : "outline"}
        size="sm"
        aria-pressed={allSitesSelected}
        onClick={() => onChange([])}
      >
        {allSitesSelected ? (
          <RiCheckLine data-icon="inline-start" />
        ) : (
          <RiCheckboxBlankCircleLine data-icon="inline-start" />
        )}
        <span>{allSitesLabel}</span>
      </Button>
      {sites.length > 0 ? (
        sites.map((site) => {
          const selected = selectedSiteIds.includes(site.id);
          const label = site.name?.trim() || site.domain?.trim() || site.id;

          return (
            <Button
              key={site.id}
              type="button"
              variant={selected ? "default" : "outline"}
              size="sm"
              aria-pressed={selected}
              onClick={() => {
                onChange(
                  selected
                    ? selectedSiteIds.filter((siteId) => siteId !== site.id)
                    : [...selectedSiteIds, site.id],
                );
              }}
            >
              {selected ? (
                <RiCheckLine data-icon="inline-start" />
              ) : (
                <RiCheckboxBlankCircleLine data-icon="inline-start" />
              )}
              <span>{label}</span>
            </Button>
          );
        })
      ) : emptySitesLabel ? (
        <p className="text-sm text-muted-foreground">{emptySitesLabel}</p>
      ) : null}
    </div>
  );
}
