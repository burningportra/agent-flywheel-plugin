export async function ok(exec) {
    return agentMailRPC(exec, "fetch_inbox", {
        project_key: "/cwd",
        agent_name: "z",
    });
}
//# sourceMappingURL=unrelated-tool.js.map