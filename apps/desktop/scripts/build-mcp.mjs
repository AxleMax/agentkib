import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const debug = process.argv.includes("--debug");
const workspace = resolve(import.meta.dirname, "../../..");
const cargoArgs = ["build", "-p", "agenthub-mcp"];
if (!debug) cargoArgs.push("--release");
execFileSync("cargo", cargoArgs, { cwd: workspace, stdio: "inherit" });
const verbose = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const target = verbose.match(/^host: (.+)$/m)?.[1];
if (!target) throw new Error("Unable to resolve Rust host target");
const source = resolve(workspace, "target", debug ? "debug" : "release", process.platform === "win32" ? "agenthub-mcp.exe" : "agenthub-mcp");
const binaries = resolve(import.meta.dirname, "../src-tauri/binaries");
mkdirSync(binaries, { recursive: true });
copyFileSync(source, resolve(binaries, `agenthub-mcp-${target}${process.platform === "win32" ? ".exe" : ""}`));
