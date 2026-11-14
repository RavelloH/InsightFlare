import { useId, useState } from "react";
import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Button } from "@insightflare/ui/button";
import { Input } from "@insightflare/ui/input";
import { Label } from "@insightflare/ui/label";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@insightflare/ui/responsive-dialog";
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiCloseLine,
  RiFileCopyLine,
  RiLink,
} from "@remixicon/react";
import { toast } from "sonner";

import {
  buildUtmLink,
  type UtmParameters,
} from "@/components/dashboard/campaigns/utm-link";
import type { AppMessages } from "@/lib/i18n/messages";

export function UtmLinkBuilder({ messages }: { messages: AppMessages }) {
  const copy = messages.campaigns.linkBuilder;
  const id = useId();
  const [destination, setDestination] = useState("");
  const [parameters, setParameters] = useState<UtmParameters>({
    source: "",
    medium: "",
    campaign: "",
    content: "",
    term: "",
  });
  const [showOptional, setShowOptional] = useState(false);
  const [urlTouched, setUrlTouched] = useState(false);
  const result = buildUtmLink(destination, parameters);
  const invalidUrl =
    urlTouched && !!destination.trim() && result.error === "url";

  async function copyLink() {
    if (!result.url) return;
    try {
      await navigator.clipboard.writeText(result.url);
      toast.success(copy.copied);
    } catch {
      toast.error(copy.copyFailed);
    }
  }

  function renderParameter(key: keyof UtmParameters, optional = false) {
    const labels = {
      source: messages.campaigns.tabSource,
      medium: messages.campaigns.tabMedium,
      campaign: messages.campaigns.tabCampaign,
      content: messages.campaigns.tabContent,
      term: messages.campaigns.tabTerm,
    };
    const placeholders = {
      source: "newsletter",
      medium: "email",
      campaign: "summer_launch",
      content: "header_banner",
      term: "analytics",
    };
    return (
      <div className="space-y-1.5" key={key}>
        <Label htmlFor={`${id}-${key}`}>
          {labels[key]}
          {!optional ? <span aria-hidden="true">*</span> : null}
          <span className="ml-auto font-mono text-[10px] font-normal text-muted-foreground">
            utm_{key}
          </span>
        </Label>
        <Input
          id={`${id}-${key}`}
          value={parameters[key]}
          onChange={(event) =>
            setParameters((current) => ({
              ...current,
              [key]: event.target.value,
            }))
          }
          placeholder={placeholders[key]}
          required={!optional}
          autoComplete="off"
        />
      </div>
    );
  }

  return (
    <ResponsiveDialog>
      <ResponsiveDialogTrigger asChild>
        <Button variant="outline">
          <RiLink data-icon="inline-start" />
          <span>{copy.title}</span>
        </Button>
      </ResponsiveDialogTrigger>
      <ResponsiveDialogContent desktopClassName="max-w-lg">
        <ResponsiveDialogHeader className="pr-8">
          <ResponsiveDialogTitle icon={RiLink}>
            {copy.title}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {copy.description}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-destination`}>
              {copy.destination}
              <span aria-hidden="true">*</span>
            </Label>
            <Input
              id={`${id}-destination`}
              type="url"
              inputMode="url"
              placeholder="https://example.com/landing"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              onBlur={() => setUrlTouched(true)}
              required
              autoComplete="off"
              spellCheck={false}
              aria-invalid={invalidUrl}
              aria-describedby={invalidUrl ? `${id}-url-error` : undefined}
            />
            <AutoResizer>
              <AutoTransition
                initial={false}
                transitionKey={invalidUrl ? "invalid-url" : "valid-url"}
              >
                {invalidUrl ? (
                  <p
                    id={`${id}-url-error`}
                    className="text-xs text-destructive"
                    role="alert"
                  >
                    {copy.invalidUrl}
                  </p>
                ) : null}
              </AutoTransition>
            </AutoResizer>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {renderParameter("source")}
              {renderParameter("medium")}
            </div>
            {renderParameter("campaign")}
          </div>
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2.5"
              aria-expanded={showOptional}
              aria-controls={`${id}-optional`}
              onClick={() => setShowOptional((current) => !current)}
            >
              <AutoResizer animateWidth animateHeight={false}>
                <AutoTransition
                  initial={false}
                  transitionKey={showOptional ? "expanded" : "collapsed"}
                  className="inline-flex items-center"
                >
                  {showOptional ? (
                    <RiArrowUpSLine className="size-3.5" />
                  ) : (
                    <RiArrowDownSLine className="size-3.5" />
                  )}
                </AutoTransition>
              </AutoResizer>
              <span>{copy.optional}</span>
            </Button>
            <div
              id={`${id}-optional`}
              aria-hidden={!showOptional}
              inert={!showOptional}
            >
              <AutoResizer>
                <AutoTransition
                  initial={false}
                  transitionKey={showOptional ? "expanded" : "collapsed"}
                >
                  {showOptional ? (
                    <div className="grid grid-cols-1 gap-3 pt-3 sm:grid-cols-2">
                      {renderParameter("content", true)}
                      {renderParameter("term", true)}
                    </div>
                  ) : null}
                </AutoTransition>
              </AutoResizer>
            </div>
          </div>
          <div className="space-y-2 border-t pt-4">
            <Label htmlFor={`${id}-result`}>{copy.result}</Label>
            <AutoResizer>
              <AutoTransition
                initial={false}
                duration={0.15}
                transitionKey={result.url ?? "empty"}
              >
                <textarea
                  id={`${id}-result`}
                  readOnly
                  value={result.url ?? ""}
                  placeholder={copy.resultPlaceholder}
                  rows={3}
                  spellCheck={false}
                  className="flex w-full resize-none border border-input bg-muted/30 px-3 py-2 font-mono text-xs leading-relaxed outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
                />
              </AutoTransition>
            </AutoResizer>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {copy.hint}
            </p>
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <ResponsiveDialogClose asChild>
            <Button variant="outline">
              <RiCloseLine data-icon="inline-start" />
              <span>{messages.common.close}</span>
            </Button>
          </ResponsiveDialogClose>
          <Button onClick={() => void copyLink()} disabled={!result.url}>
            <RiFileCopyLine data-icon="inline-start" />
            <span>{copy.copy}</span>
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
