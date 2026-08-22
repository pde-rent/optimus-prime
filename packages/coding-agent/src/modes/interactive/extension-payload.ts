import type { LoaderIndicatorOptions } from "@earendil-works/pi-tui";



export function getPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" ? value : undefined;
}

export function getPayloadNumber(payload: Record<string, unknown>, key: string): number | undefined {
	const value = payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getPayloadBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
	const value = payload[key];
	return typeof value === "boolean" ? value : undefined;
}

export function getPayloadStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
	const value = payload[key];
	if (value === undefined) {
		return undefined;
	}
	return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : undefined;
}

export function getPayloadNotifyType(payload: Record<string, unknown>, key: string): "info" | "warning" | "error" | undefined {
	const value = payload[key];
	return value === "info" || value === "warning" || value === "error" ? value : undefined;
}

export function getPayloadWidgetPlacement(
	payload: Record<string, unknown>,
	key: string,
): "aboveEditor" | "belowEditor" | undefined {
	const value = payload[key];
	return value === "aboveEditor" || value === "belowEditor" ? value : undefined;
}

export function getPayloadWorkingIndicatorOptions(
	payload: Record<string, unknown>,
	key: string,
): LoaderIndicatorOptions | undefined {
	const value = payload[key];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const optionsPayload = value as Record<string, unknown>;
	const frames = getPayloadStringArray(optionsPayload, "frames");
	const intervalMs = getPayloadNumber(optionsPayload, "intervalMs");
	return {
		...(frames === undefined ? {} : { frames }),
		...(intervalMs === undefined ? {} : { intervalMs }),
	};
}
