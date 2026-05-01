export async function bad(exec) {
    return agentMailRPC(exec, "file_reservation_paths", {
        project_key: "/cwd",
        agent_name: "x",
        paths: ["src/foo.ts"],
    });
}
//# sourceMappingURL=raw-call.js.map