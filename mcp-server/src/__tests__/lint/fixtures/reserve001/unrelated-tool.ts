declare function agentMailRPC(exec: unknown, tool: string, args: unknown): Promise<unknown>;

export async function ok(exec: unknown): Promise<unknown> {
  return agentMailRPC(exec, "fetch_inbox", {
    project_key: "/cwd",
    agent_name: "z",
  });
}
