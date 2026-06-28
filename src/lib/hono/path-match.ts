export function shouldUseHono(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/collect" ||
    pathname === "/script.js" ||
    pathname === "/healthz" ||
    pathname.startsWith("/.well-known/") ||
    pathname === "/admin/ws"
  );
}
