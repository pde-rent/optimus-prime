import { createDeviceFlowOAuthProvider, makeDeviceFlowLogin, refreshViaTokenEndpoint } from "./common.js";
import type { OAuthCredentials } from "./types.js";

const CLIENT_ID = "opencode-cli";
const OPENCODE_DEVICE_FLOW = {
	deviceUrl: "https://console.opencode.ai/auth/device/code",
	tokenUrl: "https://console.opencode.ai/auth/device/token",
	clientId: CLIENT_ID,
} as const;

/**
 * Login with OpenCode OAuth (device code flow). The user completes
 * authorization at console.opencode.ai; this polls until approved.
 */
export const loginOpenCode = makeDeviceFlowLogin(OPENCODE_DEVICE_FLOW);

export function refreshOpenCodeToken(refreshToken: string): Promise<OAuthCredentials> {
	return refreshViaTokenEndpoint({ ...OPENCODE_DEVICE_FLOW, refreshToken });
}

function createOpenCodeOAuthProvider(id: "opencode" | "opencode-go", name: string) {
	return createDeviceFlowOAuthProvider({ ...OPENCODE_DEVICE_FLOW, id, name });
}

export const opencodeOAuthProvider = createOpenCodeOAuthProvider("opencode", "OpenCode Zen");
export const opencodeGoOAuthProvider = createOpenCodeOAuthProvider("opencode-go", "OpenCode Go");
