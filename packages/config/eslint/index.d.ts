import type { Linter } from "eslint";

export declare const ignores: Linter.Config[];
export declare const purityConfig: Linter.Config[];
/** The shared config plus the purity rules, for core and templates. */
export declare const pure: Linter.Config[];
declare const bandwise: Linter.Config[];
export default bandwise;
