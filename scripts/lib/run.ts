import { spawn } from "node:child_process";

/**
 * Runs a child process without blocking the event loop.
 *
 * spawnSync froze the parent for the whole of a 10K seed/export/import. Sockets
 * the parent had pooled (Turso, Clerk, Auth0) were closed by the server
 * meanwhile, the frozen loop never noticed, and the next request reused a dead
 * socket: "fetch failed", cause "other side closed".
 */
export function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
