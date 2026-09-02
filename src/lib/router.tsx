import {
  type AnchorHTMLAttributes,
  forwardRef,
  type MouseEvent,
  useMemo,
} from "react";
import {
  useLocation,
  useNavigate,
  useRouter as useTanStackRouter,
} from "@tanstack/react-router";

import { notifyUrlStateChange } from "@/lib/client-history";
import { navigateWithTransition } from "@/lib/page-transition";

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  scroll?: boolean;
  "data-skip-page-transition"?: boolean | string;
}

function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

function shouldHandleNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    href,
    onClick,
    scroll = true,
    target,
    "data-skip-page-transition": skipPageTransition,
    ...props
  },
  ref,
) {
  const router = useRouter();

  return (
    <a
      {...props}
      ref={ref}
      href={href}
      target={target}
      data-skip-page-transition={skipPageTransition || undefined}
      onClick={(event) => {
        onClick?.(event);
        if (
          !shouldHandleNavigation(event) ||
          !isInternalHref(href) ||
          target === "_blank"
        ) {
          return;
        }
        event.preventDefault();
        if (skipPageTransition) {
          router.push(href, { scroll });
          return;
        }
        navigateWithTransition(router, href, { scroll });
      }}
    />
  );
});

export default Link;

export function usePathname(): string {
  return useLocation({ select: (location) => location.pathname });
}

export function useSearchParams(): URLSearchParams {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  return useMemo(() => new URLSearchParams(searchStr), [searchStr]);
}

export function useRouter() {
  const router = useTanStackRouter();
  const navigate = useNavigate();

  return useMemo(
    () => ({
      back: () => router.history.back(),
      forward: () => router.history.forward(),
      preload: (href: string) =>
        router.preloadRoute({ to: href }).then(() => undefined),
      push: (href: string, options?: { scroll?: boolean }) => {
        const result = navigate({
          to: href,
          resetScroll: options?.scroll !== false,
        });
        void Promise.resolve(result).then(
          notifyUrlStateChange,
          () => undefined,
        );
        return result;
      },
      refresh: () => router.invalidate(),
      replace: (href: string, options?: { scroll?: boolean }) => {
        const result = navigate({
          to: href,
          replace: true,
          resetScroll: options?.scroll !== false,
        });
        void Promise.resolve(result).then(
          notifyUrlStateChange,
          () => undefined,
        );
        return result;
      },
    }),
    [navigate, router],
  );
}
