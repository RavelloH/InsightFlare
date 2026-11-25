export interface FlagAssets {
  base: string;
  names: readonly string[];
}

export function createFlagAssetResolver({ base, names }: FlagAssets) {
  const supported = new Set(names);
  return (icon: string): string | undefined => {
    if (!icon.startsWith("flagpack:")) return undefined;
    const name = icon.slice("flagpack:".length).toLowerCase();
    return supported.has(name) ? base + "/" + name + ".svg" : undefined;
  };
}
