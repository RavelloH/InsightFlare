"use client";

import { createContext, useContext } from "react";
import type { Dictionary } from "./dictionaries";

const DictionaryContext = createContext<Dictionary>({});

export function DictionaryProvider({
  dictionary,
  children,
}: {
  dictionary: Dictionary;
  children: React.ReactNode;
}) {
  return (
    <DictionaryContext.Provider value={dictionary}>
      {children}
    </DictionaryContext.Provider>
  );
}

export function useDictionary(): Dictionary {
  return useContext(DictionaryContext);
}

export function useT() {
  const dict = useDictionary();
  return function t(key: string, fallback?: string): string {
    return dict[key] ?? fallback ?? key;
  };
}
