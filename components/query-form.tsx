import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface QueryFormProps {
  siteId: string;
  teamId?: string;
  from: number;
  to: number;
  actionPath: string;
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

export function QueryForm({ siteId, teamId, from, to, actionPath }: QueryFormProps): React.JSX.Element {
  return (
    <form action={actionPath} method="GET" className="grid gap-2 md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-end">
      {teamId ? <input type="hidden" name="teamId" value={teamId} /> : null}
      <label className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">Site Id</span>
        <Input name="siteId" defaultValue={siteId} placeholder="default" />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">From</span>
        <Input type="datetime-local" name="fromIso" defaultValue={toDateTimeLocal(from)} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">To</span>
        <Input type="datetime-local" name="toIso" defaultValue={toDateTimeLocal(to)} />
      </label>
      <Button type="submit">Refresh</Button>
    </form>
  );
}
