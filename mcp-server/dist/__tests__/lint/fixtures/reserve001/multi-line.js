export async function multiLine(exec) {
    return agentMailRPC(exec, 
    // intermediate comment
    "file_reservation_paths", {
        project_key: "/cwd",
        agent_name: "y",
        paths: ["src/bar.ts"],
    });
}
//# sourceMappingURL=multi-line.js.map