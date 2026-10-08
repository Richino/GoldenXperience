// Portrait screens that get an iOS launch image: CSS width/height and
// device pixel ratio. Shared by scripts/generate-splash.mjs (renders the
// PNGs) and src/app/layout.tsx (emits the matching link tags).
export const SPLASH_DEVICES = [
  // iPhone
  { width: 440, height: 956, ratio: 3 }, // 16 Pro Max, 17 Pro Max
  { width: 420, height: 912, ratio: 3 }, // Air
  { width: 402, height: 874, ratio: 3 }, // 16 Pro, 17, 17 Pro
  { width: 430, height: 932, ratio: 3 }, // 14 Pro Max, 15 Plus/Pro Max, 16 Plus
  { width: 393, height: 852, ratio: 3 }, // 14 Pro, 15, 15 Pro, 16, 16e
  { width: 428, height: 926, ratio: 3 }, // 12/13 Pro Max, 14 Plus
  { width: 390, height: 844, ratio: 3 }, // 12, 13, 14
  { width: 375, height: 812, ratio: 3 }, // X, XS, 11 Pro, 12/13 mini
  { width: 414, height: 896, ratio: 3 }, // XS Max, 11 Pro Max
  { width: 414, height: 896, ratio: 2 }, // XR, 11
  { width: 414, height: 736, ratio: 3 }, // 6/7/8 Plus
  { width: 375, height: 667, ratio: 2 }, // 6/7/8, SE 2nd/3rd gen
  // iPad
  { width: 1032, height: 1376, ratio: 2 }, // Pro 13" (M4)
  { width: 1024, height: 1366, ratio: 2 }, // Pro 12.9"
  { width: 834, height: 1210, ratio: 2 }, // Pro 11" (M4)
  { width: 834, height: 1194, ratio: 2 }, // Pro 11"
  { width: 820, height: 1180, ratio: 2 }, // Air 10.9", iPad 10th gen
  { width: 810, height: 1080, ratio: 2 }, // iPad 10.2"
  { width: 768, height: 1024, ratio: 2 }, // mini 5, iPad 9.7"
  { width: 744, height: 1133, ratio: 2 }, // mini 6
];
