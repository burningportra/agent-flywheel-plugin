export async function reserveOrFail(exec) {
    return agentMailRPC(exec, "file_reservation_paths", {
        project_key: "/cwd",
        agent_name: "helper",
        paths: ["src/foo.ts"],
    });
}
//# sourceMappingURL=allowlisted-helper.js.map