import {
  type ComponentType,
  lazy,
  type LazyExoticComponent,
  Suspense,
} from "react";
import { ClientOnly } from "@tanstack/react-router";

interface DynamicOptions<Props extends object> {
  loading?: ComponentType<Props>;
  ssr?: boolean;
}

export default function dynamic<Props extends object>(
  loader: () => Promise<ComponentType<Props>>,
  options: DynamicOptions<Props> = {},
): ComponentType<Props> {
  const LazyComponent: LazyExoticComponent<ComponentType<Props>> = lazy(
    async () => ({ default: await loader() }),
  );
  const Loading = options.loading ?? (() => null);

  return function DynamicComponent(props: Props) {
    const content = (
      <Suspense fallback={<Loading {...props} />}>
        <LazyComponent {...props} />
      </Suspense>
    );
    if (options.ssr === false) {
      return (
        <ClientOnly fallback={<Loading {...props} />}>{content}</ClientOnly>
      );
    }
    return content;
  };
}
