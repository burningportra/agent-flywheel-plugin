/**
 * R-001 — flywheel_capabilities snapshot tests.
 *
 * Goal: pin the capabilities envelope shape so that contract drift is
 * caught at PR time. Bumping CAPABILITIES_CONTRACT_VERSION REQUIRES
 * updating the snapshot; adding a new tool to PRIMARY_TOOLS REQUIRES
 * appending it to the snapshot's mcp_tools array. Both signals are
 * intentional review gates, not noise.
 */
export {};
//# sourceMappingURL=capabilities.test.d.ts.map