/**
 * Prime Agent session-to-session messaging skill.
 *
 * All routing and sender identity live in the host. These functions only call
 * the host bridge exposed inside the REPL.
 */
const MESSAGE_DISPLAY_MIME = "application/vnd.prime-agent.agent-message+json";
const ROLES = ["parent", "sibling", "child"];

export default function createSkill({ hostRequest, display }) {
	/** Surface a send receipt to the TUI; best-effort. */
	const emitSent = (receipt, receiverRole) => {
		try {
			if (!receipt || typeof receipt !== "object") return;
			const payload = { ...receipt };
			if (ROLES.includes(receiverRole)) payload.receiverRole = receiverRole;
			display({ mimeType: MESSAGE_DISPLAY_MIME, data: payload });
		} catch {
			// display is best-effort: never fail a send because the UI hook threw
		}
	};

	return {
		/** List this agent's parent, siblings, and children, including inactive family. */
		async list_agents() {
			return hostRequest("agent_message.list_agents", {});
		},

		/**
		 * Send one direct role-addressed message, or broadcast to the whole family.
		 *
		 * Direct:    await agent_message.send("text", { receiver_role: "parent" })
		 *            await agent_message.send("text", { receiver_role: "child", receiver_name: "api-reviewer" })
		 * Broadcast: await agent_message.send("all", { broadcast_message: "text" })
		 */
		async send(message, options = {}) {
			const {
				broadcast_message: broadcastMessage,
				receiver_role: receiverRole,
				receiver_name: receiverName,
			} = options;

			let payload;
			if (broadcastMessage !== undefined) {
				if (message !== "all") {
					throw new TypeError('broadcast requires the message argument to be "all"');
				}
				if (receiverRole !== undefined || receiverName !== undefined) {
					throw new TypeError("broadcast cannot be combined with receiver_role/receiver_name");
				}
				payload = { target: "all", message: broadcastMessage };
			} else {
				if (!ROLES.includes(receiverRole)) {
					throw new Error('receiver_role must be "parent", "sibling", or "child"');
				}
				if (typeof message !== "string") {
					throw new TypeError(`message must be a string, got ${typeof message}`);
				}
				if (receiverRole === "parent") {
					if (receiverName !== undefined) {
						throw new Error("receiver_name must be omitted for parent messages");
					}
				} else if (typeof receiverName !== "string" || !receiverName.trim()) {
					throw new Error("receiver_name is required for sibling and child messages");
				}
				payload = { message, receiver_role: receiverRole, receiver_name: receiverName ?? null };
			}

			const receipt = await hostRequest("agent_message.send", payload);
			const receipts = receipt && typeof receipt === "object" ? receipt.receipts : undefined;
			if (Array.isArray(receipts)) {
				for (const item of receipts) {
					if (item && typeof item === "object" && "deliveryStatus" in item) emitSent(item);
				}
			} else {
				emitSent(receipt, receiverRole);
			}
			return receipt;
		},
	};
}
