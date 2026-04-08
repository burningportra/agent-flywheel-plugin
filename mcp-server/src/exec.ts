import { spawn } from 'node:child_process';

export type ExecFn = (
  cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function makeExec(defaultCwd?: string): ExecFn {
  return (cmd, args, opts = {}) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? defaultCwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Timed out after ${opts.timeout}ms: ${cmd} ${args.join(' ')}`));
      }, opts.timeout);
    }
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
  });
}
