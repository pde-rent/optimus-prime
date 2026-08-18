export function isTruthyEnvVar(value: string | undefined): boolean {
	if (!value) return false;
	return (
		value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes" || value.toLowerCase() === "on"
	);
}
