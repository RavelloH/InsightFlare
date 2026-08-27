import { memo, useMemo } from "react";
import Map, { useControl } from "react-map-gl/maplibre";
import { ScatterplotLayer } from "@deck.gl/layers";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";

import {
  applyVectorBasemapColorOverrides,
  getVectorBasemapStyleUrl,
} from "@/lib/dashboard/map-basemap";
import type { Locale } from "@/lib/i18n/config";

export type VisitorDetailMapTheme = "light" | "dark";

export interface VisitorLocationPoint {
  latitude: number;
  longitude: number;
  timestampMs: number;
}

interface RenderedVisitorLocationPoint extends VisitorLocationPoint {
  id: string;
  radius: number;
  fillColor: [number, number, number, number];
}

const VISITOR_MAP_VIEW_STATE = {
  longitude: 0,
  latitude: 20,
  zoom: 1.05,
  minZoom: 0.3,
  maxZoom: 6,
  pitch: 0,
  bearing: 0,
} as const;
const VISITOR_MAP_MAX_RENDERED_POINTS = 320;
const VISITOR_MAP_POINT_RGB = [52, 211, 153] as const;
const VISITOR_MAP_POINT_BASE_RADIUS_PX = 4.8;

function resolveVisitorMapFillColor(
  opacity: number,
): [number, number, number, number] {
  return [
    VISITOR_MAP_POINT_RGB[0],
    VISITOR_MAP_POINT_RGB[1],
    VISITOR_MAP_POINT_RGB[2],
    Math.round(Math.max(0, Math.min(1, opacity)) * 255),
  ];
}

function getRenderedVisitorPointPosition(
  point: Pick<RenderedVisitorLocationPoint, "longitude" | "latitude">,
): [number, number] {
  return [point.longitude, point.latitude];
}

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

export const VisitorDetailMapStage = memo(function VisitorDetailMapStage({
  locale,
  theme,
  points,
}: {
  locale: Locale;
  theme: VisitorDetailMapTheme;
  points: VisitorLocationPoint[];
}) {
  const mapStyle = useMemo(
    () => getVectorBasemapStyleUrl(theme, locale),
    [locale, theme],
  );
  const renderedPoints = useMemo<RenderedVisitorLocationPoint[]>(
    () =>
      points.slice(0, VISITOR_MAP_MAX_RENDERED_POINTS).map((point, index) => ({
        ...point,
        id: `${point.timestampMs}:${index}`,
        radius: VISITOR_MAP_POINT_BASE_RADIUS_PX,
        fillColor: resolveVisitorMapFillColor(0.56),
      })),
    [points],
  );
  const layers = useMemo(
    () => [
      new ScatterplotLayer<RenderedVisitorLocationPoint>({
        id: "visitor-location-point",
        data: renderedPoints,
        getFillColor: (point) => point.fillColor,
        getPosition: getRenderedVisitorPointPosition,
        getRadius: (point) => point.radius,
        radiusUnits: "pixels",
        radiusMinPixels: 0,
        radiusMaxPixels: VISITOR_MAP_POINT_BASE_RADIUS_PX,
        pickable: false,
      }),
    ],
    [renderedPoints],
  );

  return (
    <div className="absolute inset-0">
      <Map
        initialViewState={VISITOR_MAP_VIEW_STATE}
        mapStyle={mapStyle}
        attributionControl={false}
        interactive={false}
        onStyleData={(event) =>
          applyVectorBasemapColorOverrides(event.target, theme)
        }
        style={{ width: "100%", height: "100%" }}
      >
        <DeckOverlay interleaved={false} layers={layers} />
      </Map>
    </div>
  );
});
