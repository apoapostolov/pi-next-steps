/**
 * next-steps for Pi: a port of the Hermes "Next Steps" plugin.
 *
 * The agent calls the `next_steps` tool with a list of option strings at the end
 * of a reply. The extension stores them and exposes `/ns` (alias `/nextsteps`)
 * to pick one or more and send them as the next user turn.
 *
 * Multi-select: type comma-separated indices (e.g. "1,3") or a single number.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface NextStepsState {
	options: string[];
	multi: boolean;
	rec: string;
	risky: string;
	subtitles: string[];
}

export default function (pi: ExtensionAPI) {
	let state: NextStepsState | null = null;

	pi.on("before_agent_start", async (event) => {
		const addition = `
When a reply naturally ends with a choice or "say the word and I'll...", call the next_steps tool with 2-6 short option strings instead of asking in prose. Mark recommended options with rec (comma indices). Use subtitles when a label alone is ambiguous.`;
		return { systemPrompt: (event.systemPrompt ?? "") + addition };
	});

	pi.registerTool({
		name: "next_steps",
		label: "Next Steps",
		description:
			"Offer clickable next-step options at the end of a reply. Call this when the user faces a choice or the reply naturally ends with 'say the word and I'll...'. Provide 2-6 short option strings.",
		parameters: {
			type: "object",
			properties: {
				options: {
					type: "array",
					items: { type: "string" },
					description: "The option labels to offer.",
				},
				multi: {
					type: "boolean",
					description: "Allow picking multiple (default true).",
				},
				rec: {
					type: "string",
					description: "Comma-separated 1-based indices to mark recommended.",
				},
				risky: {
					type: "string",
					description: "Comma-separated 1-based indices to mark risky.",
				},
				subtitles: {
					type: "array",
					items: { type: "string" },
					description: "Optional dim second lines, one per option.",
				},
			},
			required: ["options"],
		},
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const args = (params ?? {}) as any;
			const opts = ((args.options as string[]) ?? []).map((s) => String(s).trim()).filter(Boolean);
			if (opts.length === 0) {
				ctx.ui.notify("next_steps: no options", "warning");
				return { content: [{ type: "text", text: "No options provided." }] };
			}
			let rec = (args.rec as string) ?? "";
			let risky = (args.risky as string) ?? "";
			// Auto-classify recommended/risky via the session model when not provided.
			if (!rec && !risky && ctx?.model) {
				try {
					const model = ctx.model;
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (auth.ok) {
						const context: any = {
							systemPrompt: "You are a classifier. Reply with JSON only.",
							messages: [
								{
									role: "user",
									content: `Classify these next-step options. Return ONLY JSON: {"rec":[1-based indices of recommended options], "risky":[1-based indices of risky/damaging options]}. Mark 1-2 recommended when steps belong together, never all, never mutually exclusive pairs. Mark risky only options that could damage files, builds, or money.\nOptions:\n${opts.map((o, i) => `${i + 1}. ${o}`).join("\n")}`,
									timestamp: Date.now(),
								},
							],
						};
						const stream = ctx.modelRegistry.streamSimple(model, context, { apiKey: auth.apiKey, headers: auth.headers, baseUrl: auth.baseUrl });
						let msg: any = null;
						for await (const ev of stream) {
							if (ev.type === "done") msg = ev.message;
						}
						if (!msg) msg = await stream.result();
						const text = Array.isArray(msg?.content)
							? msg.content.map((c: any) => c?.text ?? "").join("")
							: String(msg?.content ?? "");
						const m = text.match(/\{[\s\S]*\}/);
						if (m) {
							try {
								const j = JSON.parse(m[0]);
								if (Array.isArray(j.rec)) rec = j.rec.join(",");
								if (Array.isArray(j.risky)) risky = j.risky.join(",");
							} catch {
								// ignore parse errors
							}
						}
					}
				} catch {
					// classification is best-effort
				}
			}
			state = {
				options: opts,
				multi: args.multi !== false,
				rec,
				risky,
				subtitles: (args.subtitles as string[]) ?? [],
			};
			const recSet = new Set((state.rec || "").split(",").map((s) => s.trim()));
			const riskySet = new Set((state.risky || "").split(",").map((s) => s.trim()));
			const lines = state.options.map((o, i) => {
				const n = i + 1;
				const tags = [
					recSet.has(String(n)) ? "★" : "",
					riskySet.has(String(n)) ? "⚠" : "",
				].filter(Boolean).join(" ");
				const sub = state!.subtitles[i] ? `  — ${state!.subtitles[i]}` : "";
				return `${n}. ${tags ? tags + " " : ""}${o}${sub}`;
			});
			ctx.ui.notify(`Next steps registered (rec=${rec || "-"}, risky=${risky || "-"}). Run /ns to pick.`, "info");
			return {
				content: [{ type: "text", text: `Registered ${opts.length} next steps:\n${lines.join("\n")}\nUse /ns to pick and send.` }],
			};
		},
	});

	async function pickAndSend(ctx: any) {
		if (!state || state.options.length === 0) {
			ctx.ui.notify("No next steps registered. Ask the agent to call next_steps.", "warning");
			return;
		}
		const opts = state.options;
		const recSet = new Set((state.rec || "").split(",").map((s) => s.trim()));
		const riskySet = new Set((state.risky || "").split(",").map((s) => s.trim()));
		const labels = opts.map((o, i) => {
			const n = i + 1;
			const tags = [recSet.has(String(n)) ? "★" : "", riskySet.has(String(n)) ? "⚠" : ""].filter(Boolean).join(" ");
			return `${n}. ${tags ? tags + " " : ""}${o}`;
		});
		const input = await ctx.ui.input(
			"Next steps (comma-separated indices, or single number)",
			labels.join("  |  "),
		);
		if (!input) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		const indices = input
			.split(",")
			.map((s) => parseInt(s.trim(), 10))
			.filter((n) => !isNaN(n) && n >= 1 && n <= opts.length);
		if (indices.length === 0) {
			ctx.ui.notify("No valid selection", "warning");
			return;
		}
		const chosen = indices.map((n) => opts[n - 1]);
		const message = chosen.length === 1 ? chosen[0] : chosen.map((c) => `- ${c}`).join("\n");
		if (ctx.isIdle()) {
			pi.sendUserMessage(message);
		} else {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
		}
		ctx.ui.notify(`Sent ${chosen.length} step(s)`, "info");
	}

	pi.registerCommand("ns", {
		description: "Pick and send a registered next step (/ns).",
		handler: async (_args, ctx) => pickAndSend(ctx),
	});
	pi.registerCommand("nextsteps", {
		description: "Pick and send a registered next step (/nextsteps).",
		handler: async (_args, ctx) => pickAndSend(ctx),
	});
}
