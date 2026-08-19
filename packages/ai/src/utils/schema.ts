/**
 * JSON Schema builders, validation and coercion, replacing `typebox`.
 *
 * The builders emit plain JSON Schema, which is what tool definitions are sent as anyway, so
 * this keeps the public `registerTool` shape extensions already use. A Zod- or Valibot-based
 * replacement would have been a second dependency (each needs a separate to-json-schema
 * package) and a breaking change to that API, for a library whose output here is a data
 * literal.
 *
 * Only the surface this codebase used is implemented: the `Type.*` builders, `Static<T>`
 * inference, `Compile(schema).Check/.Errors`, and `Value.Convert`.
 */

/** Marks a property the enclosing object does not require. */
const OPTIONAL = Symbol.for("optimus.schema.optional");

/**
 * Type-level twin of `OPTIONAL`.
 *
 * `Type.Optional` brands its result with this so the object's inferred type can split required
 * from optional keys; without it every property would infer as required and callers would be
 * forced to pass values the schema does not ask for.
 */
declare const OPTIONAL_MARKER: unique symbol;

/**
 * A schema node.
 *
 * `static` is a phantom: it carries the inferred TypeScript type and is never present at
 * runtime, which is how `Static<T>` reads a type back out of a value.
 */
export interface TSchema {
	readonly static?: unknown;
	type?: string | string[];
	properties?: Record<string, TSchema>;
	required?: string[];
	items?: TSchema;
	anyOf?: TSchema[];
	const?: unknown;
	enum?: unknown[];
	additionalProperties?: boolean | TSchema;
	patternProperties?: Record<string, TSchema>;
	description?: string;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	[key: string]: unknown;
}

export type TProperties = Record<string, TSchema>;

/** The TypeScript type a schema describes. */
export type Static<T extends TSchema> = T extends { readonly static?: infer S } ? S : never;

type SchemaOf<T> = TSchema & { readonly static?: T };

/** Keys whose schema carries the optional brand. */
type OptionalKeys<P> = { [K in keyof P]: P[K] extends { readonly [OPTIONAL_MARKER]?: true } ? K : never }[keyof P];
type RequiredKeys<P> = Exclude<keyof P, OptionalKeys<P>>;

type ObjectStatic<P extends TProperties> = {
	[K in RequiredKeys<P>]: Static<P[K]>;
} & {
	[K in OptionalKeys<P>]?: Static<P[K]>;
};

const isOptional = (schema: TSchema): boolean => (schema as Record<symbol, unknown>)[OPTIONAL] === true;

/** Strip the marker so it never reaches serialized output. */
function bare(schema: TSchema): TSchema {
	if (!isOptional(schema)) return schema;
	const copy: TSchema = { ...schema };
	delete (copy as Record<symbol, unknown>)[OPTIONAL];
	return copy;
}

type Options = Record<string, unknown>;

export const Type = {
	String: (options?: Options) => ({ type: "string", ...options }) as SchemaOf<string>,
	Number: (options?: Options) => ({ type: "number", ...options }) as SchemaOf<number>,
	Integer: (options?: Options) => ({ type: "integer", ...options }) as SchemaOf<number>,
	Boolean: (options?: Options) => ({ type: "boolean", ...options }) as SchemaOf<boolean>,
	Null: (options?: Options) => ({ type: "null", ...options }) as SchemaOf<null>,
	Any: (options?: Options) => ({ ...options }) as SchemaOf<unknown>,
	Unknown: (options?: Options) => ({ ...options }) as SchemaOf<unknown>,

	Literal: <T extends string | number | boolean>(value: T, options?: Options) =>
		({
			type: typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string",
			const: value,
			...options,
		}) as SchemaOf<T>,

	Array: <T extends TSchema>(items: T, options?: Options) =>
		({ type: "array", items: bare(items), ...options }) as SchemaOf<Static<T>[]>,

	Union: <T extends TSchema[]>(variants: [...T], options?: Options) =>
		({ anyOf: variants.map(bare), ...options }) as SchemaOf<Static<T[number]>>,

	// `patternProperties` rather than `additionalProperties`, matching the schema the package
	// emitted; consumers and caches see the same bytes.
	Record: <V extends TSchema>(_keys: TSchema, values: V, options?: Options) =>
		({ type: "object", patternProperties: { "^.*$": bare(values) }, ...options }) as SchemaOf<
			Record<string, Static<V>>
		>,

	/** Escape hatch for a schema whose TypeScript type cannot be derived from its shape. */
	Unsafe: <T>(schema: TSchema) => schema as SchemaOf<T>,

	Optional: <T extends TSchema>(schema: T) =>
		({ ...schema, [OPTIONAL]: true }) as unknown as T & { readonly [OPTIONAL_MARKER]?: true },

	Object: <P extends TProperties>(properties: P, options?: Options) => {
		const required: string[] = [];
		const shape: Record<string, TSchema> = {};
		for (const [key, value] of Object.entries(properties)) {
			if (!isOptional(value)) required.push(key);
			shape[key] = bare(value);
		}
		// Key order matches the package's: `required` before `properties`. Schemas are
		// serialized into the request, so the byte order is part of the prompt-cache prefix.
		// An object with no required keys omits the array entirely, as JSON Schema expects.
		const schema: TSchema =
			required.length > 0
				? { type: "object", required, properties: shape, ...options }
				: { type: "object", properties: shape, ...options };
		return schema as SchemaOf<ObjectStatic<P>>;
	},
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** One validation failure, in the shape the callers already format. */
export interface ValidationError {
	/** JSON Pointer to the offending value, e.g. `/colors/background`. */
	instancePath: string;
	schemaPath: string;
	keyword: string;
	params: Record<string, unknown>;
	message: string;
}

export type TLocalizedValidationError = ValidationError;

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
			return typeof value === "number" && !Number.isNaN(value);
		case "object":
			return typeOf(value) === "object";
		default:
			return typeOf(value) === type;
	}
}

/** Collect every failure under `schema`, depth-first, in document order. */
function collect(schema: TSchema, value: unknown, path: string, errors: ValidationError[]): void {
	const fail = (keyword: string, message: string, params: Record<string, unknown> = {}): void => {
		errors.push({ instancePath: path, schemaPath: `#/${keyword}`, keyword, params, message });
	};

	if (schema.anyOf) {
		// A union reports only its own failure: the branch errors describe alternatives that
		// were never meant to match, and listing them buries the real problem.
		const matched = schema.anyOf.some((variant) => {
			const branch: ValidationError[] = [];
			collect(variant, value, path, branch);
			return branch.length === 0;
		});
		if (!matched) fail("anyOf", "must match a schema in anyOf");
		return;
	}

	if (schema.const !== undefined && value !== schema.const) {
		fail("const", `must be equal to constant`, { allowedValue: schema.const });
		return;
	}

	const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
		fail("type", `must be ${types.join(" or ")}`, { type: schema.type });
		return;
	}

	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) {
			fail("minimum", `must be >= ${schema.minimum}`, { limit: schema.minimum });
		}
		if (schema.maximum !== undefined && value > schema.maximum) {
			fail("maximum", `must be <= ${schema.maximum}`, { limit: schema.maximum });
		}
	}

	if (typeof value === "string") {
		if (schema.minLength !== undefined && value.length < schema.minLength) {
			fail("minLength", `must NOT have fewer than ${schema.minLength} characters`, { limit: schema.minLength });
		}
		if (schema.maxLength !== undefined && value.length > schema.maxLength) {
			fail("maxLength", `must NOT have more than ${schema.maxLength} characters`, { limit: schema.maxLength });
		}
		if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
			fail("pattern", `must match pattern "${schema.pattern}"`, { pattern: schema.pattern });
		}
	}

	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		fail("enum", "must be equal to one of the allowed values", { allowedValues: schema.enum });
	}

	if (schema.items && Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			collect(schema.items as TSchema, item, `${path}/${index}`, errors);
		}
	}

	if (typeOf(value) === "object") {
		const record = value as Record<string, unknown>;
		const missing = (schema.required ?? []).filter((key) => record[key] === undefined);
		if (missing.length > 0) {
			// Reported as one error carrying every missing key, which is what the theme loader
			// reads to list absent colours in a single message.
			fail("required", `must have required property '${missing[0]}'`, {
				missingProperty: missing[0],
				requiredProperties: missing,
			});
		}
		for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
			if (record[key] === undefined) continue;
			collect(propertySchema, record[key], `${path}/${escapePointer(key)}`, errors);
		}
		const patterns = Object.entries((schema.patternProperties as Record<string, TSchema> | undefined) ?? {}).map(
			([source, subSchema]) => [new RegExp(source), subSchema] as const,
		);
		const extra = schema.additionalProperties;
		for (const [key, entry] of Object.entries(record)) {
			if (schema.properties && key in schema.properties) continue;
			const matched = patterns.filter(([pattern]) => pattern.test(key));
			if (matched.length > 0) {
				for (const [, subSchema] of matched) collect(subSchema, entry, `${path}/${escapePointer(key)}`, errors);
				continue;
			}
			if (extra === undefined || extra === true) continue;
			if (extra === false) {
				fail("additionalProperties", `must NOT have additional properties`, { additionalProperty: key });
				continue;
			}
			collect(extra, entry, `${path}/${escapePointer(key)}`, errors);
		}
	}
}

/** JSON Pointer escaping: `~` and `/` are the two reserved characters. */
const escapePointer = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

export interface Validator<T = unknown> {
	/** Narrows on success, which is how call sites use the result. */
	Check(value: unknown): value is T;
	Errors(value: unknown): ValidationError[];
}

export function Compile<S extends TSchema>(schema: S): Validator<Static<S>> {
	return {
		Check(value: unknown): value is Static<S> {
			const errors: ValidationError[] = [];
			collect(schema, value, "", errors);
			return errors.length === 0;
		},
		Errors(value: unknown): ValidationError[] {
			const errors: ValidationError[] = [];
			collect(schema, value, "", errors);
			return errors;
		},
	};
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** Coerce one scalar toward the type its schema names; anything else passes through. */
function convertScalar(schema: TSchema, value: unknown): unknown {
	const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (types.length === 0) return value;
	if (types.some((type) => matchesType(value, type))) return value;

	if (typeof value === "string") {
		if (types.includes("number") || types.includes("integer")) {
			const parsed = Number(value);
			if (value.trim() !== "" && !Number.isNaN(parsed)) {
				return types.includes("integer") && !Number.isInteger(parsed) ? value : parsed;
			}
		}
		if (types.includes("boolean")) {
			if (value === "true") return true;
			if (value === "false") return false;
		}
		if (types.includes("null") && value === "null") return null;
	}
	if (typeof value === "number" && types.includes("string")) return String(value);
	if (typeof value === "boolean" && types.includes("string")) return String(value);
	return value;
}

function convert(schema: TSchema, value: unknown): unknown {
	if (schema.anyOf) {
		// Try each branch and keep the first conversion that satisfies it, so a union of
		// number and string does not stringify a numeric input.
		for (const variant of schema.anyOf) {
			const candidate = convert(variant, value);
			if (Compile(variant).Check(candidate)) return candidate;
		}
		return value;
	}
	if (Array.isArray(value) && schema.items) {
		return value.map((item) => convert(schema.items as TSchema, item));
	}
	if (typeOf(value) === "object") {
		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = { ...record };
		for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
			if (record[key] === undefined) continue;
			out[key] = convert(propertySchema, record[key]);
		}
		const patterns = Object.entries((schema.patternProperties as Record<string, TSchema> | undefined) ?? {}).map(
			([source, subSchema]) => [new RegExp(source), subSchema] as const,
		);
		const extra = schema.additionalProperties;
		for (const key of Object.keys(record)) {
			if (schema.properties && key in schema.properties) continue;
			const matched = patterns.find(([pattern]) => pattern.test(key));
			if (matched) {
				out[key] = convert(matched[1], record[key]);
				continue;
			}
			if (extra && extra !== true) out[key] = convert(extra, record[key]);
		}
		return out;
	}
	return convertScalar(schema, value);
}

export const Value = {
	/**
	 * Coerce `value` toward `schema` in place where possible.
	 *
	 * Mutates the object it is given, which is how the caller uses it: tool arguments arrive as
	 * JSON where a model may have sent `"3"` for a number.
	 */
	Convert(schema: TSchema, value: unknown): unknown {
		const converted = convert(schema, value);
		if (typeOf(value) === "object" && typeOf(converted) === "object") {
			Object.assign(value as Record<string, unknown>, converted as Record<string, unknown>);
			return value;
		}
		return converted;
	},
};
