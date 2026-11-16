/**
 * next-steps for Pi: a port of the Hermes "Next Steps" plugin.
 *
 * The agent calls the `next_steps` tool with a list of option strings at the end
 * of a reply. The extension stores them and exposes `/ns` (alias `/nextsteps`)
 * to pick one or more and send them as the next user turn.
 *
 * Settings: ~/.pi/agent/next-steps.json
 *   markRisky (bool, default false), carryForward (bool, default false),
 *   steerOnClick (bool, default false), accentRecommended (bool, default true).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface NextStepsState {
	options: string[];
	multi: boolean;
	rec: string;
	risky: string;
	subtitles: string[];
	alternates: string;
}

interface Settings {
	markRisky: boolean;
	carryForward: boolean;
	steerOnClick: boolean;
	accentRecommended: boolean;
}

const SETTINGS_PATH = join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent", "next-steps.json");

function loadSettings(): Settings {
	const defaults: Settings = { markRisky: false, carryForward: false, steerOnClick: false, accentRecommended: true };
	try {
		if (existsSync(SETTINGS_PATH)) {
			const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
			return { ...defaults, ...raw };
		}
	} catch {}
	// write defaults
	try {
		mkdirSync(join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent"), { recursive: true });
		writeFileSync(SETTINGS_PATH, JSON.stringify(defaults, null, 2));
	} catch {}
	return defaults;
}

export default function (pi: ExtensionAPI) {
	const settings = loadSettings();
	let state: NextStepsState | null = null;
	// carry-forward queue: array of { options, rec, risky, subtitles, age }
	const queue: { options: string[]; rec: string; risky: string; subtitles: string[]; age: number }[] = [];

	pi.on("before_agent_start", async (event) => {
		const addition = `
When a reply naturally ends with a choice or "say the word and I'll...", call the next_steps tool with 2-6 short option strings instead of asking in prose. Mark recommended options with rec (comma indices). Use subtitles when a label alone is ambiguous.`;
		let sp = (event.systemPrompt ?? "") + addition;
		if (settings.carryForward && queue.length > 0) {
			const carried = queue
				.slice()
				.reverse()
				.map((q, i) => `[${i + 1} reply back] ${q.options.join(" | ")}`)
				.join("\n");
			sp += `\n\nCarried unanswered options from earlier replies (youngest first):\n${carried}`;
		}
		return { systemPrompt: sp };
	});

	pi.on("turn_end", async () => {
		if (state && state.options.length > 0) {
			// age existing queue
			for (const q of queue) q.age++;
			queue.unshift({ options: state.options, rec: state.rec, risky: state.risky, subtitles: state.subtitles, age: 0 });
			if (queue.length > 30) queue.pop();
			// clear state after carrying
			if (!settings.carryForward) state = null;
		}
	});

	pi.registerTool({
		name: "next_steps",
		label: "Next Steps",
		description:
			"Offer selectable next-step options at the end of a reply. Call this when the user faces a choice or the reply naturally ends with 'say the word and I'll...'. Provide 2-6 short option strings.",
		parameters: {
			type: "object",
			properties: {
				options: { type: "array", items: { type: "string" }, description: "The option labels to offer." },
				multi: { type: "boolean", description: "Allow picking multiple (default true)." },
				rec: { type: "string", description: "Comma-separated 1-based indices to mark recommended." },
				risky: { type: "string", description: "Comma-separated 1-based indices to mark risky." },
				subtitles: { type: "array", items: { type: "string" }, description: "Optional dim second lines, one per option." },
				alternates: { type: "string", description: "Groups of mutually exclusive indices, e.g. '1,3|2'." },
				carry: { type: "boolean", description: "Record this reply's options for carry-forward (default follows setting)." },
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
			// Auto-classify when not provided (best-effort, silent on failure)
			if (!rec && !risky && settings.markRisky && ctx?.model) {
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
					// classification best-effort
				}
			}
			const alternates = (args.alternates as string) ?? "";
			state = {
				options: opts,
				multi: args.multi !== false,
				rec,
				risky,
				subtitles: (args.subtitles as string[]) ?? [],
				alternates,
			};
			if (args.carry === true) settings.carryForward = true;
			const recSet = new Set((state.rec || "").split(",").map((s) => s.trim()));
			const riskySet = new Set((state.risky || "").split(",").map((s) => s.trim()));
			const lines = state.options.map((o, i) => {
				const n = i + 1;
				const tags = [
					settings.accentRecommended && recSet.has(String(n)) ? "★" : "",
					settings.markRisky && riskySet.has(String(n)) ? "⚠" : "",
				].filter(Boolean).join(" ");
				const sub = state!.subtitles[i] ? `  — ${state!.subtitles[i]}` : "";
				return `${n}. ${tags ? tags + " " : ""}${o}${sub}`;
			});
			ctx.ui.notify(`Next steps registered. Run /ns to pick.`, "info");
			return {
				content: [{ type: "text", text: `Registered ${opts.length} next steps:\n${lines.join("\n")}\nUse /ns to pick and send.` }],
			};
		},
	});

	async function pickAndSend(ctx: any) {
		if (!state || state.options.length === 0) {
			// try carry-forward queue
			if (queue.length > 0) {
				const q = queue[0];
				state = { options: q.options, multi: true, rec: q.rec, risky: q.risky, subtitles: q.subtitles, alternates: "" };
			} else {
				ctx.ui.notify("No next steps registered. Ask the agent to call next_steps.", "warning");
				return;
			}
		}
		const opts = state.options;
		const recSet = new Set((state.rec || "").split(",").map((s) => s.trim()));
		const riskySet = new Set((state.risky || "").split(",").map((s) => s.trim()));
		// parse alternate groups
		const altGroups: number[][] = [];
		if (state.alternates) {
			for (const g of state.alternates.split("|")) {
				const members = g.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 1 && n <= opts.length);
				if (members.length >= 2) altGroups.push(members);
			}
		}
		const labels = opts.map((o, i) => {
			const n = i + 1;
			const tags = [
				settings.accentRecommended && recSet.has(String(n)) ? "★" : "",
				settings.markRisky && riskySet.has(String(n)) ? "⚠" : "",
			].filter(Boolean).join(" ");
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
		let indices = input
			.split(",")
			.map((s) => parseInt(s.trim(), 10))
			.filter((n) => !isNaN(n) && n >= 1 && n <= opts.length);
		// enforce alternate groups
		for (const g of altGroups) {
			const picked = indices.filter((n) => g.includes(n));
			if (picked.length > 1) {
				// keep the first
				const first = picked[0];
				indices = indices.filter((n) => !g.includes(n) || n === first);
			}
		}
		if (indices.length === 0) {
			ctx.ui.notify("No valid selection", "warning");
			return;
		}
		const chosen = indices.map((n) => opts[n - 1]);
		const message = chosen.length === 1 ? chosen[0] : chosen.map((c) => `- ${c}`).join("\n");
		if (ctx.isIdle()) {
			pi.sendUserMessage(message);
		} else if (settings.steerOnClick) {
			pi.sendUserMessage(message, { deliverAs: "steer" });
		} else {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
		}
		// retire from carry queue
		if (queue.length > 0) queue.shift();
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
	pi.registerCommand("nextsteps-settings", {
		description: "Show next-steps settings path.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Settings: ${SETTINGS_PATH}`, "info");
		},
	});
}
