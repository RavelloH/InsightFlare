import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
} from "react";
import { Icon } from "@iconify/react";

type FlagAssetResolver = (icon: string) => string | undefined;
const FlagAssetContext = createContext<FlagAssetResolver | null>(null);

export function FlagAssetProvider({
  resolve,
  children,
}: {
  resolve: FlagAssetResolver;
  children: ReactNode;
}) {
  return (
    <FlagAssetContext.Provider value={resolve}>
      {children}
    </FlagAssetContext.Provider>
  );
}

export interface FlagIconProps {
  icon: string;
  className?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean | "true" | "false";
}

/** App assets render during SSR; standalone library consumers retain Iconify. */
export function FlagIcon({
  icon,
  className,
  style,
  "aria-hidden": hidden = true,
}: FlagIconProps) {
  const resolve = useContext(FlagAssetContext);
  const src = resolve?.(icon);
  if (src)
    return (
      <img
        src={src}
        width={16}
        height={12}
        alt=""
        className={className}
        style={style}
        aria-hidden={hidden}
      />
    );
  if (resolve && icon.startsWith("flagpack:")) {
    // Invalid/unsupported values must not trigger requests to third-party APIs.
    return (
      <span
        className={className}
        style={{ width: 16, height: 12, ...style }}
        aria-hidden={hidden}
      />
    );
  }
  return (
    <Icon
      icon={icon}
      className={className}
      style={style}
      aria-hidden={hidden}
    />
  );
}
