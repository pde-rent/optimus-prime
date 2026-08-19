/**
 * Language definitions `@speed-highlight/core` does not ship.
 *
 * The package covers 33 languages; these are the ones this codebase is actually read in that
 * were missing, so a `.zig` or `.sol` file rendered as flat unhighlighted text. Written in the
 * package's own rule format — an ordered list of `{type, match}` where the earliest match wins
 * and `sub` recurses — so they drop straight into the same tokenizer.
 *
 * Token types must be ones the theme paints: kwd, type, class, num, bool, str, cmnt, func, var,
 * oper, section.
 */

/** Shape of one rule; mirrors the package's, minus the parts these definitions do not use. */
interface Rule {
	type?: string;
	match?: RegExp;
	sub?: string | Rule[];
	expand?: string;
}

/** Comment, string and number rules shared by the C-family syntaxes below. */
const LINE_AND_BLOCK_COMMENTS: Rule = { match: /\/\/.*\n?|\/\*((?!\*\/)[\s\S])*(\*\/)?/g, sub: "todo" };
const CLASS_NAMES: Rule = { type: "class", match: /\b[A-Z][\w_]*\b/g };
const CALLS: Rule = { type: "func", match: /[a-zA-Z_][\w_]*(?=\s*[(<])/g };
const C_OPERATORS: Rule = { type: "oper", match: /[/*+:?&|%^~=!,<>.-]+/g };

export const zig: Rule[] = [
	LINE_AND_BLOCK_COMMENTS,
	{ type: "str", match: /\\\\.*|(["'])(\\[\s\S]|(?!\1)[^\r\n\\])*\1?/g },
	{ expand: "num" },
	{
		type: "kwd",
		match: /\b(align|allowzero|and|anyframe|anytype|asm|async|await|break|catch|comptime|const|continue|defer|else|enum|errdefer|error|export|extern|fn|for|if|inline|linksection|noalias|noinline|nosuspend|opaque|or|orelse|packed|pub|resume|return|struct|suspend|switch|test|threadlocal|try|union|unreachable|usingnamespace|var|volatile|while)\b/g,
	},
	{ type: "bool", match: /\b(true|false|null|undefined)\b/g },
	{
		type: "type",
		match: /\b(bool|void|type|anyerror|noreturn|[iu](8|16|32|64|128|size)|f(16|32|64|80|128)|c_\w+)\b/g,
	},
	// Builtins are the `@`-prefixed calls, which are the most distinctive thing on a Zig line.
	{ type: "func", match: /@[a-zA-Z_]\w*/g },
	CLASS_NAMES,
	CALLS,
	C_OPERATORS,
];

export const solidity: Rule[] = [
	LINE_AND_BLOCK_COMMENTS,
	{ expand: "str" },
	{ expand: "num" },
	{ type: "kwd", match: /\bpragma\s+solidity[^;]*/g },
	{
		type: "kwd",
		match: /\b(abstract|anonymous|as|assembly|break|calldata|catch|constant|constructor|continue|contract|delete|do|else|emit|enum|event|external|fallback|for|function|if|immutable|import|indexed|interface|internal|is|library|mapping|memory|modifier|new|override|payable|private|public|pure|receive|return|returns|revert|storage|struct|try|type|unchecked|using|view|virtual|while)\b/g,
	},
	{ type: "bool", match: /\b(true|false)\b/g },
	{
		type: "type",
		match: /\b(address|bool|bytes([1-9]|[12]\d|3[0-2])?|string|u?int(8|16|24|32|64|128|256)?)\b/g,
	},
	// The globals that carry the security-relevant context.
	{ type: "var", match: /\b(msg|block|tx|abi|super|this)\b(?=\.)/g },
	CLASS_NAMES,
	CALLS,
	C_OPERATORS,
];

export const scala: Rule[] = [
	LINE_AND_BLOCK_COMMENTS,
	{ type: "str", match: /"""(?:(?!""")[\s\S])*(?:""")?|(["'])(?:\\[\s\S]|(?!\1)[^\r\n\\])*\1?/g },
	{ expand: "num" },
	{
		type: "kwd",
		match: /\b(abstract|case|catch|class|def|do|else|enum|extends|final|finally|for|forSome|given|if|implicit|import|lazy|match|new|object|override|package|private|protected|return|sealed|super|then|this|throw|trait|try|type|using|val|var|while|with|yield)\b/g,
	},
	{ type: "bool", match: /\b(true|false|null|None|Nil)\b/g },
	{ type: "var", match: /'[a-zA-Z_]\w*|@\w+/g },
	CLASS_NAMES,
	CALLS,
	{ type: "oper", match: /=>|<-|<:|>:|[/*+:?&|%^~=!,<>.-]+/g },
];

export const kotlin: Rule[] = [
	LINE_AND_BLOCK_COMMENTS,
	{ type: "str", match: /"""(?:(?!""")[\s\S])*(?:""")?|(["'])(?:\\[\s\S]|(?!\1)[^\r\n\\])*\1?/g },
	{ expand: "num" },
	{
		type: "kwd",
		match: /\b(abstract|actual|annotation|as|break|by|catch|class|companion|const|constructor|continue|crossinline|data|delegate|do|dynamic|else|enum|expect|external|final|finally|for|fun|get|if|import|in|infix|init|inline|inner|interface|internal|is|lateinit|noinline|null|object|open|operator|out|override|package|private|protected|public|reified|return|sealed|set|super|suspend|tailrec|this|throw|try|typealias|val|var|vararg|when|where|while)\b/g,
	},
	{ type: "bool", match: /\b(true|false|null)\b/g },
	{ type: "var", match: /@\w+/g },
	CLASS_NAMES,
	CALLS,
	{ type: "oper", match: /\?:|!!|[/*+:?&|%^~=!,<>.-]+/g },
];

export const swift: Rule[] = [
	LINE_AND_BLOCK_COMMENTS,
	{ type: "str", match: /"""((?!""")[\s\S])*("""?)?|"((?!")[^\r\n\\]|\\[\s\S])*"?/g },
	{ expand: "num" },
	{
		type: "kwd",
		match: /\b(actor|any|as|associatedtype|async|await|break|case|catch|class|continue|convenience|default|defer|deinit|didSet|do|dynamic|else|enum|extension|fallthrough|fileprivate|final|for|func|get|guard|if|import|in|indirect|infix|init|inout|internal|is|lazy|let|mutating|nonisolated|nonmutating|open|operator|optional|override|postfix|prefix|private|protocol|public|repeat|required|rethrows|return|self|set|some|static|struct|subscript|super|switch|throw|throws|try|typealias|var|weak|where|while|willSet)\b/g,
	},
	{ type: "bool", match: /\b(true|false|nil)\b/g },
	// Attributes and compiler directives.
	{ type: "var", match: /@\w+|#\w+/g },
	CLASS_NAMES,
	CALLS,
	{ type: "oper", match: /\?\?|->|[/*+:?&|%^~=!,<>.-]+/g },
];

export const cpp: Rule[] = [
	LINE_AND_BLOCK_COMMENTS,
	{ type: "str", match: /R"\((?:(?!\)")[\s\S])*\)"?|(["'])(?:\\[\s\S]|(?!\1)[^\r\n\\])*\1?/g },
	{ expand: "num" },
	{ type: "kwd", match: /#\s*\w+/g },
	{
		type: "kwd",
		match: /\b(alignas|alignof|and|asm|auto|break|case|catch|class|co_await|co_return|co_yield|concept|const|consteval|constexpr|constinit|const_cast|continue|decltype|default|delete|do|dynamic_cast|else|enum|explicit|export|extern|final|for|friend|goto|if|inline|mutable|namespace|new|noexcept|operator|override|private|protected|public|reinterpret_cast|requires|return|sizeof|static|static_assert|static_cast|struct|switch|template|this|thread_local|throw|try|typedef|typeid|typename|union|using|virtual|volatile|while)\b/g,
	},
	{ type: "bool", match: /\b(true|false|nullptr|NULL)\b/g },
	{
		type: "type",
		match: /\b(bool|char|char8_t|char16_t|char32_t|double|float|int|long|short|signed|unsigned|void|wchar_t|size_t|u?int(8|16|32|64)_t)\b/g,
	},
	CLASS_NAMES,
	CALLS,
	{ type: "oper", match: /::|->|[/*+:?&|%^~=!,<>.-]+/g },
];

export const ruby: Rule[] = [
	{ match: /#.*/g, sub: "todo" },
	{ type: "str", match: /(["'])(\\[\s\S]|(?!\1)[^\r\n\\])*\1?|%[wiqQ]?[[({][^\])}]*[\])}]/g },
	{ expand: "num" },
	{
		type: "kwd",
		match: /\b(alias|and|begin|break|case|class|def|defined\?|do|else|elsif|end|ensure|for|if|in|module|next|not|or|redo|require|require_relative|rescue|retry|return|self|super|then|undef|unless|until|when|while|yield)\b/g,
	},
	{ type: "bool", match: /\b(true|false|nil)\b/g },
	// Instance, class and global variables, plus symbols.
	{ type: "var", match: /[@$]\w+|:\w+/g },
	CLASS_NAMES,
	{ type: "func", match: /\b[a-z_]\w*[?!]?(?=\s*\()/g },
	C_OPERATORS,
];

export const csharp: Rule[] = [
	LINE_AND_BLOCK_COMMENTS,
	{ type: "str", match: /@?"((?!")[^\r\n\\]|\\[\s\S])*"?/g },
	{ expand: "num" },
	{
		type: "kwd",
		match: /\b(abstract|as|async|await|base|break|case|catch|checked|class|const|continue|default|delegate|do|else|enum|event|explicit|extern|finally|fixed|for|foreach|get|goto|if|implicit|in|init|interface|internal|is|lock|namespace|new|operator|out|override|params|partial|private|protected|public|readonly|record|ref|return|sealed|set|sizeof|stackalloc|static|struct|switch|this|throw|try|typeof|unchecked|unsafe|using|var|virtual|volatile|where|while|yield)\b/g,
	},
	{ type: "bool", match: /\b(true|false|null)\b/g },
	{
		type: "type",
		match: /\b(bool|byte|char|decimal|double|dynamic|float|int|long|object|sbyte|short|string|u?int|ulong|ushort|void)\b/g,
	},
	{ type: "var", match: /\[[A-Z]\w*(\([^)]*\))?\]/g },
	CLASS_NAMES,
	CALLS,
	{ type: "oper", match: /=>|\?\?|[/*+:?&|%^~=!,<>.-]+/g },
];

export const php: Rule[] = [
	{ match: /\/\/.*|#(?!\[).*|\/\*((?!\*\/)[\s\S])*(\*\/)?/g, sub: "todo" },
	{ type: "str", match: /<<<'?(\w+)'?[\s\S]*?\1|(["'])(\\[\s\S]|(?!\2)[^\r\n\\])*\2?/g },
	{ expand: "num" },
	{ type: "kwd", match: /<\?php|\?>/g },
	{
		type: "kwd",
		match: /\b(abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|do|echo|else|elseif|empty|enum|extends|final|finally|fn|for|foreach|function|global|goto|if|implements|include|include_once|instanceof|insteadof|interface|isset|list|match|namespace|new|or|print|private|protected|public|readonly|require|require_once|return|static|switch|throw|trait|try|unset|use|var|while|xor|yield)\b/g,
	},
	{ type: "bool", match: /\b(true|false|null)\b/gi },
	{ type: "var", match: /\$\w+/g },
	CLASS_NAMES,
	CALLS,
	{ type: "oper", match: /=>|->|::|\?\?|[/*+:?&|%^~=!,<>.-]+/g },
];
