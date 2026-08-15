export function toUnixSeconds(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000));
}
