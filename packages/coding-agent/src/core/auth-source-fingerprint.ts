import { createHash } from "node:crypto";

/** Stable per-source fingerprint: `<source>:<sha256(source\0material)>`. */
function fingerprintAuthSource(source: string, material: string): string {
	const digest = createHash("sha256").update(source).update("\0").update(material).digest("hex");
	return `${source}:${digest}`;
}

interface AuthSourceFingerprintOptions<S extends string, C extends boolean> {
	source: S;
	configured: C;
	label?: string;
	identityMaterial: string;
	valueMaterial?: string;
	resolveValueMaterial?: () => string | undefined;
}

interface AuthSourceFingerprints<S extends string, C extends boolean> {
	configured: C;
	source: S;
	label?: string;
	identityFingerprint: string;
	valueFingerprint?: string;
	resolveValueFingerprint?: () => string | undefined;
}

/**
 * Build the identity/value fingerprint triple shared by AuthStorage status
 * candidates and ModelRegistry provider-request auth sources.
 */
export function createAuthSourceFingerprints<S extends string, C extends boolean = false>(
	options: AuthSourceFingerprintOptions<S, C>,
): AuthSourceFingerprints<S, C> {
	return {
		configured: options.configured,
		source: options.source,
		...(options.label ? { label: options.label } : {}),
		identityFingerprint: fingerprintAuthSource(options.source, `identity:${options.identityMaterial}`),
		...(options.valueMaterial !== undefined
			? {
					valueFingerprint: fingerprintAuthSource(
						options.source,
						`value:${options.identityMaterial}\0${options.valueMaterial}`,
					),
				}
			: {}),
		...(options.resolveValueMaterial
			? {
					resolveValueFingerprint: () => {
						const valueMaterial = options.resolveValueMaterial?.();
						return valueMaterial === undefined
							? undefined
							: fingerprintAuthSource(options.source, `value:${options.identityMaterial}\0${valueMaterial}`);
					},
				}
			: {}),
	};
}
