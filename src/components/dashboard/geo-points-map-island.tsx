import { createIsomorphicFn } from "@tanstack/react-start";

import { Spinner } from "@/components/ui/spinner";
import dynamic from "@/lib/dynamic";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import type {
  GeoPointsMapCountryCount,
  GeoPointsMapPoint,
} from "./geo-points-map-3d";

interface GeoPointsMapIslandProps {
  locale: Locale;
  messages: AppMessages;
  points: GeoPointsMapPoint[];
  countryCounts?: GeoPointsMapCountryCount[];
  loading?: boolean;
  emptyLabel?: string;
  heightClassName?: string;
  initialZoom?: number;
  countryHoverEnabled?: boolean;
  pointColor?: [number, number, number];
  bordered?: boolean;
  reuseMaps?: boolean;
  projectionMode?: "mercator" | "globe";
  autoRotate?: boolean;
  selectedCountryCode?: string | null;
  onCountrySelect?: (countryCode: string | null) => void;
  collapseOverlappingPointColors?: boolean;
  pointCrossfadeEnabled?: boolean;
}

const DEFAULT_MAP_HEIGHT_CLASS = "h-[460px]";

function GeoPointsMapFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden border border-border/70 bg-muted/20">
      <Spinner className="size-6" />
    </div>
  );
}

type FlatGeoPointsMapProps = Omit<
  GeoPointsMapIslandProps,
  | "projectionMode"
  | "autoRotate"
  | "collapseOverlappingPointColors"
  | "pointCrossfadeEnabled"
>;

type GeoPointsMap3DProps = Omit<
  GeoPointsMapIslandProps,
  "projectionMode" | "initialZoom" | "reuseMaps"
>;

const FlatGeoPointsMapClient = createIsomorphicFn()
  .server(() => GeoPointsMapFallback)
  .client(() =>
    dynamic<FlatGeoPointsMapProps>(
      () =>
        import("@/components/dashboard/geo-points-map-flat").then(
          (module) => module.FlatGeoPointsMap,
        ),
      {
        ssr: false,
        loading: GeoPointsMapFallback,
      },
    ),
  )();

const GeoPointsMap3DClient = createIsomorphicFn()
  .server(() => GeoPointsMapFallback)
  .client(() =>
    dynamic<GeoPointsMap3DProps>(
      () =>
        import("@/components/dashboard/geo-points-map-3d").then(
          (module) => module.GeoPointsMap3D,
        ),
      {
        ssr: false,
        loading: GeoPointsMapFallback,
      },
    ),
  )();

export type { GeoPointsMapCountryCount, GeoPointsMapPoint };

export function GeoPointsMapIsland({
  heightClassName,
  initialZoom,
  projectionMode = "mercator",
  autoRotate,
  reuseMaps,
  collapseOverlappingPointColors,
  pointCrossfadeEnabled,
  ...props
}: GeoPointsMapIslandProps) {
  const isGlobe = projectionMode === "globe";

  return (
    <div className={`${heightClassName ?? DEFAULT_MAP_HEIGHT_CLASS} w-full`}>
      {isGlobe ? (
        <GeoPointsMap3DClient
          {...props}
          autoRotate={autoRotate}
          collapseOverlappingPointColors={collapseOverlappingPointColors}
          pointCrossfadeEnabled={pointCrossfadeEnabled}
          heightClassName="h-full"
        />
      ) : (
        <FlatGeoPointsMapClient
          {...props}
          heightClassName="h-full"
          initialZoom={initialZoom}
          reuseMaps={reuseMaps}
        />
      )}
    </div>
  );
}
