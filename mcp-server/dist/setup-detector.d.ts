export type InstallPlan = {
    install: string[];
    register: string[];
    start: string[];
    configure: string[];
    skip: string[];
};
/**
 * Names of the ACFS-stack CLIs the flywheel detects. Order is preserved
 * in the resulting `install` / `skip` buckets so the skill can render a
 * stable list to the user.
 */
export declare const REQUIRED_CLIS: readonly ["br", "bv", "cm", "dcg", "ntm"];
export type RequiredCli = (typeof REQUIRED_CLIS)[number];
export type Probes = {
    hasCli: (bin: RequiredCli) => Promise<boolean>;
    isAgentMailAlive: () => Promise<boolean>;
    isMcpRegistered: () => Promise<boolean>;
    getNtmBase: () => Promise<string | null>;
};
export declare function detectInstallState(opts: {
    cwd: string;
    probes?: Partial<Probes>;
}): Promise<InstallPlan>;
//# sourceMappingURL=setup-detector.d.ts.map