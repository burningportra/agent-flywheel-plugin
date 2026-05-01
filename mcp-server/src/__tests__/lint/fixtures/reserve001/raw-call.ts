declare function agentMailRPC(exec: unknown, tool: string, args: unknown): Promise<unknown>;

export async function bad(exec: unknown): Promise<unknown> {
  return agentMailRPC(exec, "file_reservation_paths", {
    project_key: "/cwd",
    agent_name: "x",
    paths: ["src/foo.ts"],
  });
}
