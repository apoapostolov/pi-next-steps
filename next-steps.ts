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
import { matchesKey } from "@earendil-works/pi-tui";
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
	rewriteProseOffers: boolean;
}

const SETTINGS_PATH = join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent", "next-steps.json");

function loadSettings(): Settings {
	const defaults: Settings = { markRisky: false, carryForward: false, steerOnClick: false, accentRecommended: true, rewriteProseOffers: false };
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
	let states: NextStepsState[] = [];
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

	// Prose-offer parser: detect a trailing offer in the last assistant message.
	function planOffer(text: string): string[] | null {
		if (!text || !text.trim()) return null;
		const TRIGGER = /(?:want me to|should i|shall i|do you want|pick one|choose one)\b/i;
		const blocks = text.split("\n\n");
		let last = -1;
		for (let i = blocks.length - 1; i >= 0; i--) {
			if (blocks[i].trim()) { last = i; break; }
		}
		if (last < 0) return null;
		const lastBlock = blocks[last].trim();
		if (!TRIGGER.test(lastBlock)) return null;
		// extract bullets
		const bullets: string[] = [];
		for (const line of lastBlock.split("\n")) {
			const m = line.match(/^[-*•]\s+(.+)$/);
			if (m) bullets.push(m[1].trim());
		}
		if (bullets.length >= 2) return bullets.slice(0, 6);
		// single sentence option
		const sentence = lastBlock.replace(TRIGGER, "").trim();
		if (sentence.length > 0 && sentence.length < 120) return [sentence];
		return null;
	}

	pi.on("turn_end", async (event: any) => {
		// prose-offer rewrite
		if (settings.rewriteProseOffers && states.length === 0) {
			try {
				const msgs = event?.messages ?? [];
				const lastAssistant = [...msgs].reverse().find((m: any) => m?.role === "assistant");
				let text = "";
				if (typeof lastAssistant?.content === "string") {
					text = lastAssistant.content;
				} else if (Array.isArray(lastAssistant?.content)) {
					text = lastAssistant.content.map((c: any) => c?.text ?? "").join("");
				}
				const opts = planOffer(text);
				if (opts && opts.length >= 2) {
					states.push({ options: opts, multi: true, rec: "", risky: "", subtitles: [], alternates: "" });
				}
			} catch {
				// ignore
			}
		}
		if (states.length > 0) {
			// age existing queue
			for (const q of queue) q.age++;
			for (const st of states) {
				queue.unshift({ options: st.options, rec: st.rec, risky: st.risky, subtitles: st.subtitles, age: 0 });
				if (queue.length > 30) queue.pop();
			}
			// clear states after carrying
			if (!settings.carryForward) states = [];
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
			const newState: NextStepsState = {
				options: opts,
				multi: args.multi !== false,
				rec,
				risky,
				subtitles: (args.subtitles as string[]) ?? [],
				alternates,
			};
			states.push(newState);
			if (args.carry === true) settings.carryForward = true;
			const recSet = new Set((states[0].rec || "").split(",").map((s) => s.trim()));
			const riskySet = new Set((states[0].risky || "").split(",").map((s) => s.trim()));
			const lines = newState.options.map((o, i) => {
				const n = i + 1;
				const tags = [
					settings.accentRecommended && recSet.has(String(n)) ? "★" : "",
					settings.markRisky && riskySet.has(String(n)) ? "▲" : "",
				].filter(Boolean).join(" ");
				const sub = newState.subtitles[i] ? `  — ${newState.subtitles[i]}` : "";
				const tagPrefix = tags ? `${tags} ` : "";
				return `${n}. ${tagPrefix}${o}${sub}`;
			});
			// Render an interactive choice right away instead of forcing /ns.
			const choiceLabels = newState.options.map((o, i) => {
				const n = i + 1;
				const recTag = settings.accentRecommended && recSet.has(String(n)) ? " ★ RECOMMENDED" : "";
				const riskyTag = settings.markRisky && riskySet.has(String(n)) ? " ▲ RISKY" : "";
				const sub = newState.subtitles[i] ? `  — ${newState.subtitles[i]}` : "";
				return `${o}${sub}${recTag}${riskyTag}`;
			});
			try {
				const selected = new Set<number>();
				const result = await ctx.ui.custom<number[] | null>((tui, theme, _kb, done) => {
					let cursor = 0;
					const component = {
						focused: true,
						render(_width: number): string[] {
							const lines: string[] = [];
							lines.push(theme.fg("accent", "Next steps (space toggle, enter confirm):"));
							for (let i = 0; i < choiceLabels.length; i++) {
								const check = selected.has(i) ? "[x]" : "[ ]";
								const prefix = i === cursor ? theme.fg("accent", "> ") : "  ";
								lines.push(`${prefix}${check} ${choiceLabels[i]}`);
							}
							lines.push(theme.fg("dim", "space toggle · ↑↓ move · enter/tab confirm · esc cancel"));
							return lines;
						},
						invalidate() {},
						handleInput(data: string) {
							if (matchesKey(data, "up") || matchesKey(data, "k")) {
								cursor = (cursor - 1 + choiceLabels.length) % choiceLabels.length;
								tui.requestRender();
							} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
								cursor = (cursor + 1) % choiceLabels.length;
								tui.requestRender();
							} else if (matchesKey(data, "space")) {
								if (selected.has(cursor)) selected.delete(cursor);
								else selected.add(cursor);
								tui.requestRender();
							} else if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
								done(Array.from(selected).sort((a, b) => a - b));
							} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
								done(null);
							}
						},
					};
					return component;
				});
				if (result && result.length > 0) {
					const chosen = result.map((n) => newState.options[n]);
					const message = chosen.length === 1 ? chosen[0] : chosen.map((c) => `- ${c}`).join("\n");
					if (ctx.isIdle()) {
						pi.sendUserMessage(message);
					} else if (settings.steerOnClick) {
						pi.sendUserMessage(message, { deliverAs: "steer" });
					} else {
						pi.sendUserMessage(message, { deliverAs: "followUp" });
					}
					if (queue.length > 0) queue.shift();
					ctx.ui.notify(`Sent ${chosen.length} step(s)`, "info");
				} else if (result !== null) {
					// empty selection (enter with nothing toggled) — send nothing
					ctx.ui.notify("No selection", "info");
				}
			} catch {
				// Non-interactive mode or UI unavailable; fall back to /ns.
			}
			ctx.ui.notify(`Next steps registered.`, "info");
			return {
				content: [{ type: "text", text: `Registered ${opts.length} next steps:\n${lines.join("\n")}` }],
			};
		},
	});

	async function pickAndSend(ctx: any) {
		if (states.length === 0 || states[0].options.length === 0) {
			// try carry-forward queue
			if (queue.length > 0) {
				const q = queue[0];
				states = [{ options: q.options, multi: true, rec: q.rec, risky: q.risky, subtitles: q.subtitles, alternates: "" }];
			} else {
				ctx.ui.notify("No next steps registered. Ask the agent to call next_steps.", "warning");
				return;
			}
		}
		const opts = states[0].options;
		const recSet = new Set((states[0].rec || "").split(",").map((s) => s.trim()));
		const riskySet = new Set((states[0].risky || "").split(",").map((s) => s.trim()));
		// parse alternate groups
		const altGroups: number[][] = [];
		if (states[0].alternates) {
			for (const g of states[0].alternates.split("|")) {
				const members = g.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 1 && n <= opts.length);
				if (members.length >= 2) altGroups.push(members);
			}
		}
		const labels = opts.map((o, i) => {
			const n = i + 1;
			const tags = [
				settings.accentRecommended && recSet.has(String(n)) ? "★" : "",
				settings.markRisky && riskySet.has(String(n)) ? "▲" : "",
			].filter(Boolean).join(" ");
			const tagPrefix2 = tags ? `${tags} ` : "";
			return `${n}. ${tagPrefix2}${o}`;
		});
		const input = await ctx.ui.input(
			"Next steps: type indices (e.g. 1,3) then Enter",
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
