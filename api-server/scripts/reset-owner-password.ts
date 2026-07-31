import { stdin as input, stdout as output } from "node:process";
import { resetOwnerPassword } from "../src/auth.js";

function hiddenQuestion(prompt: string) {
  return new Promise<string>((resolve) => {
    let value = ""; output.write(prompt); input.setRawMode?.(true); input.resume();
    const onData = (chunk: Buffer) => { const key = chunk.toString(); if (key === "\r" || key === "\n") { input.off("data", onData); input.setRawMode?.(false); output.write("\n"); resolve(value); return; } if (key === "\u0003") process.exit(130); if (key === "\b" || key === "\x7f") { value = value.slice(0, -1); return; } value += key; };
    input.on("data", onData);
  });
}

const password = await hiddenQuestion("New password (8+ chars): ");
await resetOwnerPassword(password);
console.log("Owner password reset. All existing sessions were signed out.");
