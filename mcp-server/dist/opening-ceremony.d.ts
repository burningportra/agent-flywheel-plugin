import type { OpeningCeremonyFrame, OpeningCeremonyMode, OpeningCeremonyOptions, OpeningCeremonyResult, OpeningCeremonyWriter } from "./types.js";
export declare function getOpeningCeremonyFrames(): OpeningCeremonyFrame[];
export declare function resolveOpeningCeremonyMode(options?: OpeningCeremonyOptions): OpeningCeremonyMode;
export declare function runOpeningCeremony(writer: OpeningCeremonyWriter, options?: OpeningCeremonyOptions): Promise<OpeningCeremonyResult>;
//# sourceMappingURL=opening-ceremony.d.ts.map