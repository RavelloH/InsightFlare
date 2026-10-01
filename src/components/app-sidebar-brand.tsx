import Image from "@/lib/image";
import Link from "@/lib/router";

interface AppSidebarBrandProps {
  href: string;
  appName: string;
  suffix: string;
  target?: string;
}

export function AppSidebarBrand({
  href,
  appName,
  suffix,
  target,
}: AppSidebarBrandProps) {
  return (
    <Link
      href={href}
      target={target}
      className="relative block h-10 overflow-hidden"
    >
      <div className="absolute inset-y-0 left-0 flex items-center whitespace-nowrap transition-[opacity,transform] duration-[380ms] ease-[cubic-bezier(0.4,0,0.2,1)] group-data-[collapsible=icon]:-translate-x-2 group-data-[collapsible=icon]:opacity-0 motion-reduce:transition-none">
        <p className="flex items-center justify-center gap-2 text-xl text-primary md:justify-start">
          <span>{appName}</span>
          <span className="text-muted-foreground">{suffix}</span>
        </p>
      </div>
      <div className="absolute inset-y-0 left-0 flex w-8 items-center justify-center opacity-0 transition-[opacity,transform] duration-[380ms] ease-[cubic-bezier(0.4,0,0.2,1)] group-data-[collapsible=icon]:opacity-100 motion-reduce:transition-none">
        <Image
          src="/android-chrome-192x192.png"
          alt={appName}
          width={192}
          height={192}
          className="size-6"
          priority
        />
      </div>
    </Link>
  );
}
