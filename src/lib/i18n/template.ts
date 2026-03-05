export function formatI18nTemplate(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_full, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
