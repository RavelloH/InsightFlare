import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";

interface MetricCardProps {
  label: string;
  value: string;
  delta?: number | null;
  inverted?: boolean;
  loading?: boolean;
}

export function MetricCard({
  label,
  value,
  delta,
  inverted = false,
  loading = false,
}: MetricCardProps) {
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  const effectiveDelta = hasDelta ? (inverted ? -delta : delta) : null;
  const isUp = (effectiveDelta ?? 0) >= 0;
  const deltaText = hasDelta ? `${isUp ? "+" : ""}${(effectiveDelta ?? 0).toFixed(1)}%` : null;

  return (
    <Card size="sm" className="gap-2">
      <CardHeader className="pb-0">
        <CardTitle className="text-muted-foreground text-xs">{label}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <AutoResizer className="min-h-8" initial>
          <AutoTransition initial className="min-h-8">
            {loading ? (
              <div key="loading" className="inline-flex min-h-8 items-center">
                <Spinner className="size-4" />
              </div>
            ) : (
              <p key="value" className="font-mono text-xl font-semibold tracking-tight">
                {value}
              </p>
            )}
          </AutoTransition>
        </AutoResizer>
        {deltaText ? (
          <p className={`mt-1 text-xs ${isUp ? "text-emerald-600" : "text-rose-600"}`}>{deltaText}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
