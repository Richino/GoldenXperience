export const TEXT_SIZE_STORAGE_KEY = "goldenxperience-text-size";

export const TEXT_SIZES = ["small", "medium", "large"] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

export function isTextSize(value: string | null | undefined): value is TextSize {
  return TEXT_SIZES.includes(value as TextSize);
}

export function applyTextSizeClass(size: TextSize) {
  const root = document.documentElement;
  root.classList.remove("text-size-small", "text-size-medium", "text-size-large");
  if (size !== "medium") {
    root.classList.add(`text-size-${size}`);
  }
}

export function readStoredTextSize(): TextSize {
  if (typeof window === "undefined") return "medium";
  try {
    const stored = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
    return isTextSize(stored) ? stored : "medium";
  } catch {
    return "medium";
  }
}
