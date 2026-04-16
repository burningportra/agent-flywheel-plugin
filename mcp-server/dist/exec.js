import { spawn } from 'node:child_process';
export function makeExec(defaultCwd) {
    return (cmd, args, opts = {}) => new Promise((resolve, reject) => {
        if (opts.signal?.aborted) {
            reject(new Error("Aborted"));
            return;
        }
        const child = spawn(cmd, args, {
            cwd: opts.cwd ?? defaultCwd,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: opts.signal,
        });
        let stdout = '', stderr = '';
        child.stdout?.on('data', (d) => { stdout += d.toString(); });
        child.stderr?.on('data', (d) => { stderr += d.toString(); });
        let timer;
        if (opts.timeout) {
            timer = setTimeout(() => {
                child.kill('SIGTERM');
                reject(new Error(`Timed out after ${opts.timeout}ms: ${cmd} ${args.join(' ')}`));
            }, opts.timeout);
        }
        const abortHandler = () => { child.kill('SIGTERM'); };
        if (opts.signal) {
            opts.signal.addEventListener('abort', abortHandler, { once: true });
        }
        child.on('close', (code) => {
            if (timer)
                clearTimeout(timer);
            if (opts.signal)
                opts.signal.removeEventListener('abort', abortHandler);
            resolve({ code: code ?? 1, stdout, stderr });
        });
        child.on('error', (err) => {
            if (timer)
                clearTimeout(timer);
            if (opts.signal)
                opts.signal.removeEventListener('abort', abortHandler);
            reject(err);
        });
    });
}
//# sourceMappingURL=exec.js.map