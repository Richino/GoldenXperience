import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { IOS_TOP_CLEARANCE_SCRIPT } from "../src/lib/pwa/ios-top-clearance";

// Execute the actual first-paint script, including Home Screen UAs that omit
// Safari's Version token. The native standalone flag is the reliable signal.
const iphone27 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1";
const iphoneHome = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const cases = [
  { name: "iOS 27 Home Screen app", navigator: { userAgent: iphone27, standalone: true }, expected: true },
  { name: "iOS 27.0.1 Home Screen app", navigator: { userAgent: iphone27.replace("Version/27.0", "Version/27.0.1"), standalone: true }, expected: true },
  { name: "Home Screen app without Safari version", navigator: { userAgent: iphoneHome, standalone: true }, expected: true },
  { name: "versionless Safari tab", navigator: { userAgent: iphoneHome, standalone: false }, expected: false },
  { name: "iOS 27 Safari tab", navigator: { userAgent: iphone27, standalone: false }, expected: false },
  { name: "iOS 26 Home Screen app", navigator: { userAgent: iphone27.replace("Version/27.0", "Version/26.5"), standalone: true }, expected: true },
  { name: "iPad desktop-style UA", navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1", standalone: true }, expected: true },
  { name: "future Safari version", navigator: { userAgent: iphone27.replace("Version/27.0", "Version/28.0"), standalone: true }, expected: true },
  { name: "Android installed app", navigator: { userAgent: "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/145.0 Mobile Safari/537.36" }, expected: false },
  { name: "desktop Safari", navigator: { userAgent: "Mozilla/5.0 (Macintosh) Version/27.0 Safari/605.1.15" }, expected: false },
  { name: "unrecognized iOS version", navigator: { userAgent: "Mozilla/5.0 (iPhone) Mobile/15E148", standalone: true }, expected: true },
  { name: "Home Screen app with no UA available", navigator: { standalone: true }, expected: true },
  { name: "invalid truthy standalone value", navigator: { userAgent: iphoneHome, standalone: "true" }, expected: false },
];
for (const scenario of cases) {
  const classes = new Set(["dark", "gx-ios-pwa-top-clearance"]);
  runInNewContext(IOS_TOP_CLEARANCE_SCRIPT, {
    navigator: scenario.navigator,
    document: { documentElement: { classList: { toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name); } } } },
  });
  assert.equal(classes.has("gx-ios-pwa-top-clearance"), scenario.expected, scenario.name);
  assert.equal(classes.has("dark"), true, `${scenario.name}: preserve theme`);
}
assert.doesNotThrow(() => runInNewContext(IOS_TOP_CLEARANCE_SCRIPT, {}), "Unsupported context must fail quietly");
console.log(`Passed ${cases.length} platform checks and unsupported-context fallback.`);
