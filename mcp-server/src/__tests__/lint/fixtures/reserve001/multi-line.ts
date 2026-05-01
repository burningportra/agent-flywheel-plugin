declare function agentMailRPC<T>(exec: unknown, tool: string, args: unknown): Promise<T>;

export async function multiLine(exec: unknown): Promise<unknown> {
  return agentMailRPC<unknown>(
    exec,
    // intermediate comment
    "file_reservation_paths",
    {
      project_key: "/cwd",
      agent_name: "y",
      paths: ["src/bar.ts"],
    },
  );
}
