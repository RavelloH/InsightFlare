export type OverlayFrameKind =
  "dialog" | "drawer" | "sheet" | "alert-dialog" | "detail-drawer" | "command";

export type OverlayFrameState = "opening" | "open" | "closing";

export type LayerPortalSlot =
  "page-floating" | "backdrop" | "surface" | "floating" | "system";

export interface OverlayFrameRecord {
  id: string;
  kind: OverlayFrameKind;
  parentFrameId: string | null;
  order: number;
  state: OverlayFrameState;
}

export interface OverlayFrameContextValue {
  id: string;
  parentFrameId: string | null;
  root: HTMLElement | null;
  backdropHost: HTMLElement | null;
  surfaceHost: HTMLElement | null;
  floatingHost: HTMLElement | null;
}
