import "../src/env.js";
import { ensureRegistryDirs } from "../src/registry/store.js";
import { printFullReport } from "../src/hunt/report.js";

ensureRegistryDirs();
printFullReport();
