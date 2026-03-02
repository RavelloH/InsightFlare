import { Skeleton } from "@/components/ui/skeleton";

export function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      {/* Metric cards */}
      <div className="rounded-md border bg-card overflow-hidden grid grid-cols-2 md:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="shadow-[0_0_0_0.5px] shadow-border p-4 min-h-[88px] flex flex-col justify-center gap-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-8 w-24" />
          </div>
        ))}
      </div>
      {/* Full-width chart widget */}
      <div className="rounded-md border bg-card p-4">
        <Skeleton className="h-[280px] w-full" />
      </div>
      {/* 2-column widget grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-md border bg-card overflow-hidden">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-6 w-20" />
            </div>
            <div className="space-y-0 divide-y divide-border">
              {Array.from({ length: 5 }).map((_, j) => (
                <div key={j} className="flex items-center justify-between px-4 py-2.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-12" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="rounded-md border bg-card">
      <div className="p-6">
        <Skeleton className="h-6 w-32 mb-4" />
        <div className="space-y-3">
          <div className="flex gap-4">
            {Array.from({ length: cols }).map((_, i) => (
              <Skeleton key={i} className="h-4 flex-1" />
            ))}
          </div>
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex gap-4">
              {Array.from({ length: cols }).map((_, j) => (
                <Skeleton key={j} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
