export declare const CURSOR_SDK_STARTUP_NOISE_PATTERNS: readonly string[];
export type CursorSdkCapabilityNotice = "outsidePlugin" | "parserUnavailable";
export type CursorSdkOutputNoticeHandler = (kind: CursorSdkCapabilityNotice, message: string) => void | boolean;
export declare function isCursorSdkOutputSuppressed(): boolean;
export declare function suppressCursorSdkOutput<T>(operation: () => T): T;
export declare function withCursorSdkOutputNoticeHandler<T>(handler: CursorSdkOutputNoticeHandler | undefined, operation: () => T): T;
export declare function isCursorSdkStartupNoise(text: string): boolean;
export declare function installCursorSdkOutputFilter(): () => void;
