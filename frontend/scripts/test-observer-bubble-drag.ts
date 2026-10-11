import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as positioning from "../src/lib/observer-bubble-position";

// Exercise the actual hook's event lifecycle without adding a DOM dependency.
// Model touch's implicit child capture and its bubbling loss when the row takes it.
function mount() {
  const effects: Array<() => (() => void) | void> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const frames = new Map<number, () => void>();
  let frameId = 0, capture: "button" | "row" | null = null;
  const style: Record<string, unknown> = { setProperty(name: string, value: string) { style[name] = value; } };
  const button = { closest: () => null, getBoundingClientRect: () => ({ left: 418, top: 650, width: 58, height: 58 }) };
  const row = {
    style, querySelector: () => button, getBoundingClientRect: () => ({ height: 100 }),
    setPointerCapture: () => { capture = "row"; }, hasPointerCapture: () => capture === "row",
    releasePointerCapture: () => { capture = null; },
  };
  const hookModule = { exports: {} as { useObserverBubbleDrag: (enabled: boolean) => ReturnType<typeof import("../src/lib/use-observer-bubble-drag").useObserverBubbleDrag> } };
  const source = fs.readFileSync(new URL("../src/lib/use-observer-bubble-drag.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, {
    exports: hookModule.exports, module: hookModule,
    require: (name: string) => {
      if (name === "./observer-bubble-position") return positioning;
      assert.equal(name, "react");
      return {
        useRef: (current: unknown) => ({ current }), useCallback: (callback: unknown) => callback,
        useEffect: (effect: () => (() => void) | void) => effects.push(effect),
        useState: (initial: unknown) => { let value = initial; return [value, (next: unknown) => { value = typeof next === "function" ? next(value) : next; }]; },
      };
    },
    window: { innerWidth: 492, innerHeight: 884, addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), removeEventListener: (name: string) => listeners.delete(name) },
    ResizeObserver: class { observe() {} disconnect() {} }, performance,
    requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const hook = hookModule.exports.useObserverBubbleDrag(true);
  hook.setRow(row as unknown as HTMLDivElement);
  const cleanup = effects.map(effect => effect());
  const emit = (name: string, event: unknown) => { assert(listeners.has(name)); listeners.get(name)!(event); };
  const flush = () => { for (const [id, callback] of frames) { frames.delete(id); callback(); } };
  const pointer = (x: number, y: number, target = button) => ({ pointerId: 1, clientX: x, clientY: y, isPrimary: true, button: 0, pointerType: "touch", target, currentTarget: row, preventDefault() {} });
  const start = () => { capture = "button"; hook.handlers.onPointerDown(pointer(447, 679) as never); };
  const move = (x: number, y: number) => { emit("pointermove", pointer(x, y)); flush(); };
  const lost = (target: unknown) => hook.handlers.onLostPointerCapture({ pointerId: 1, target, currentTarget: row } as never);
  const click = () => { let prevented = false; hook.handlers.onClickCapture({ preventDefault: () => { prevented = true; }, stopPropagation() {} } as never); return prevented; };
  return { start, move, lost, click, row, button, style, emit, dispose: () => cleanup.forEach(clean => clean?.()) };
}

const touch = mount();
touch.start(); touch.move(400, 600);
const firstLeft = touch.style.left;
// Before the next pointermove, touch capture transfers from the button to the row.
touch.lost(touch.button);
touch.move(150, 400);
assert.notEqual(touch.style.left, firstLeft, "A child's capture loss must not end the touch drag");
assert.equal(touch.style.left, "179px", "The mascot continues following the finger across the screen");
touch.emit("pointerup", { pointerId: 1 });
assert.equal(touch.style.left, "121px", "Release mirrors inward while keeping the mascot at its dropped coordinate");
assert.equal(touch.click(), true, "Dragging must not open the chat");
const released = touch.style.left;
touch.move(400, 700);
assert.equal(touch.style.left, released, "The drag ends on finger release");
touch.dispose();

const interrupted = mount();
interrupted.start(); interrupted.move(400, 600); interrupted.lost(interrupted.row);
const stopped = interrupted.style.left;
interrupted.move(150, 400);
assert.equal(interrupted.style.left, stopped, "Losing the row's own capture still ends the drag");
interrupted.dispose();

const tap = mount();
tap.start(); tap.move(449, 681); tap.emit("pointerup", { pointerId: 1 });
assert.equal(tap.click(), false, "A tap and small finger jitter still open the chat");
assert.equal(tap.style.left, undefined, "A tap does not reposition the mascot");
tap.dispose();
console.log("Observer drag checks passed: touch capture transfer, continued dragging, inward mirroring, release/capture loss and tap-versus-drag behavior.");
