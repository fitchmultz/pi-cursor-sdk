export {
	__testUtils,
	installCursorSdkProcessOutputFilter,
	withCursorSdkOutputNoticeHandler,
	installCursorSdkOutputFilter,
	isCursorSdkOutputSuppressed,
	isCursorSdkStartupNoise,
	suppressCursorSdkOutput,
} from "../shared/cursor-sdk-output-filter.mjs";
export type { CursorSdkCapabilityNotice, CursorSdkOutputNoticeHandler } from "../shared/cursor-sdk-output-filter.mjs";
