// Fixture intended to simulate the allowlisted agent-mail-helpers.ts module.
// Tests inject the allowlist suffix that matches this file's relative path.
declare function agentMailRPC(exec: unknown, tool: string, args: unknown): Promise<unknown>;

export async function reserveOrFail(exec: unknown): Promise<unknown> {
  return agentMailRPC(exec, "file_reservation_paths", {
    project_key: "/cwd",
    agent_name: "helper",
    paths: ["src/foo.ts"],
  });
}
