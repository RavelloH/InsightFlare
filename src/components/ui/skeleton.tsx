import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("skeleton-loading rounded-none bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
