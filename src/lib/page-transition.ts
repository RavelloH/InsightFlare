type NavigateOptions = {
  replace?: boolean;
  scroll?: boolean;
};

export type NavigateRequest = {
  href: string;
  replace?: boolean;
  scroll?: boolean;
};

type TransitionHandler = (request: NavigateRequest) => void;

interface RouterLike {
  push: (href: string, options?: { scroll?: boolean }) => void;
  replace: (href: string, options?: { scroll?: boolean }) => void;
}

let transitionHandler: TransitionHandler | null = null;

export function registerPageTransitionHandler(
  handler: TransitionHandler,
): () => void {
  transitionHandler = handler;
  return () => {
    if (transitionHandler === handler) {
      transitionHandler = null;
    }
  };
}

export function navigateWithTransition(
  router: RouterLike,
  href: string,
  options?: NavigateOptions,
) {
  if (transitionHandler) {
    transitionHandler({
      href,
      replace: options?.replace,
      scroll: options?.scroll,
    });
    return;
  }

  if (options?.replace) {
    router.replace(href, { scroll: options?.scroll });
    return;
  }

  router.push(href, { scroll: options?.scroll });
}
