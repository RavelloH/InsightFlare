export const WEBSOCKET_ATTACHMENT_VERSION = 1;

export interface WebSocketAttachment {
  version: typeof WEBSOCKET_ATTACHMENT_VERSION;
  connectedAtMs: number;
}

export function websocketCloseCode(code: number): number {
  if (
    code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1011) ||
    (code >= 3000 && code <= 4999)
  ) {
    return code;
  }
  return 1000;
}

export function getDurableObjectWebSockets(
  state: DurableObjectState,
): WebSocket[] {
  return typeof state.getWebSockets === "function" ? state.getWebSockets() : [];
}
