import { spawn } from "node:child_process";

const command = "C:\\Program Files\\nodejs\\node.EXE";
const args = [
  "C:/Users/Cliente/AppData/Roaming/npm/node_modules/@google/gemini-cli/bundle/gemini.js",
  "--output-format", "stream-json",
  "--model", "gemini-2.5-flash",
  "--approval-mode", "yolo",
  "--sandbox=none",
  "--prompt", "Voce e o CEO. Responda curto em PT-BR. Diga apenas OK.",
];

const env = {
  ...process.env,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};

console.log("spawning:", command, args.length, "args");
const started = Date.now();
const child = spawn(command, args, {
  cwd: "C:\\Users\\Cliente\\.paperclip\\instances\\default\\workspaces\\b3bd4a02-780f-4bb9-8f93-b515210b2993",
  env,
  detached: false,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => { stdout += c; process.stderr.write(`stdout+${c.length}\n`); });
child.stderr.on("data", (c) => { stderr += c; process.stderr.write(`stderr+${c.length}\n`); });
child.on("exit", (code, sig) => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nexit code=${code} sig=${sig} elapsed=${elapsed}s`);
  console.log("STDOUT:", stdout.slice(0, 500));
  console.log("STDERR:", stderr.slice(0, 500));
});
setTimeout(() => { if (child.exitCode === null) { console.log("TIMEOUT 30s -- killing"); child.kill(); } }, 30000);
