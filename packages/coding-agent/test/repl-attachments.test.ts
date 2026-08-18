import { describe, expect, it } from "bun:test";
import { imageBlocksFromAttachments } from "../src/core/bun-repl/tool.js";
import type { KernelAttachment } from "../src/core/tools/repl-types.js";

describe("imageBlocksFromAttachments", () => {
	it("returns no blocks when there are no attachments", () => {
		expect(imageBlocksFromAttachments(undefined)).toEqual([]);
		expect(imageBlocksFromAttachments([])).toEqual([]);
	});

	it("converts supported image attachments to ImageContent blocks", () => {
		const attachments: KernelAttachment[] = [
			{ mimeType: "image/png", data: "AAAA", path: "/tmp/a.png" },
			{ mimeType: "image/jpeg", data: "BBBB" },
		];
		expect(imageBlocksFromAttachments(attachments)).toEqual([
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "image", data: "BBBB", mimeType: "image/jpeg" },
		]);
	});

	it("drops non-image attachments", () => {
		const attachments: KernelAttachment[] = [
			{ mimeType: "application/pdf", data: "CCCC" },
			{ mimeType: "image/webp", data: "DDDD" },
		];
		expect(imageBlocksFromAttachments(attachments)).toEqual([
			{ type: "image", data: "DDDD", mimeType: "image/webp" },
		]);
	});
});
