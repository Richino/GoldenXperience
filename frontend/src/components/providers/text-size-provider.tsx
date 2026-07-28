"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  applyTextSizeClass,
  readStoredTextSize,
  TEXT_SIZE_STORAGE_KEY,
  type TextSize,
} from "@/lib/text-size";

interface TextSizeContextValue {
  textSize: TextSize;
  setTextSize: (size: TextSize) => void;
  mounted: boolean;
}

const TextSizeContext = createContext<TextSizeContextValue | null>(null);

export function TextSizeProvider({ children }: { children: React.ReactNode }) {
  const [textSize, setTextSizeState] = useState<TextSize>(readStoredTextSize);
  const mounted = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );

  useEffect(() => {
    if (!mounted) return;
    applyTextSizeClass(textSize);
    try {
      localStorage.setItem(TEXT_SIZE_STORAGE_KEY, textSize);
    } catch {
      // Ignore storage failures (private browsing, etc.)
    }
  }, [mounted, textSize]);

  const setTextSize = useCallback((size: TextSize) => {
    setTextSizeState(size);
  }, []);

  const value = useMemo(
    () => ({ textSize, setTextSize, mounted }),
    [textSize, setTextSize, mounted],
  );

  return (
    <TextSizeContext.Provider value={value}>{children}</TextSizeContext.Provider>
  );
}

export function useTextSize() {
  const context = useContext(TextSizeContext);
  if (!context) {
    throw new Error("useTextSize must be used within a TextSizeProvider");
  }
  return context;
}
