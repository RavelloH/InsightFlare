import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
}

export function MetricCard({ label, value, hint }: MetricCardProps): React.JSX.Element {
  return (
    <Card className="border-slate-200 bg-white/90">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium uppercase tracking-[0.15em] text-slate-500">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold text-ink">{value}</div>
        {hint ? <p className="mt-2 text-xs text-slate-500">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

