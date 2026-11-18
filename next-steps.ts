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
	// carry-forward queue: array of { options, rec, risky, subtitles, age, reply }, newest first
	const queue: { options: string[]; rec: string; risky: string; subtitles: string[]; age: number; reply: number }[] = [];
	// Counts replies that offered steps, so `/ns clear X` can target the last X posts.
	let replyCounter = 0;
	const keyOf = (options: string[]) => options.join("\u0000");
	// Labels answered during their own turn; only what is left gets carried.
	const pickedThisTurn = new Set<string>();

	// Drop answered labels from a block and remap its tags so the indexes still line up.
	function withoutPicked(st: NextStepsState) {
		const keep: number[] = [];
		st.options.forEach((o, i) => {
			if (!pickedThisTurn.has(o)) keep.push(i);
		});
		const remap = (list: string) =>
			list
				.split(",")
				.map((s) => parseInt(s.trim(), 10))
				.filter((n) => !isNaN(n))
				.map((n) => keep.indexOf(n - 1) + 1)
				.filter((n) => n > 0)
				.join(",");
		return {
			options: keep.map((i) => st.options[i]),
			rec: remap(st.rec),
			risky: remap(st.risky),
			subtitles: keep.map((i) => st.subtitles[i] ?? ""),
		};
	}

	// Remove picked labels from every carried block; a block with nothing left is dropped.
	function retirePicked(picked: string[]) {
		const set = new Set(picked);
		for (let i = queue.length - 1; i >= 0; i--) {
			const rest = queue[i].options.filter((o) => !set.has(o));
			if (rest.length === 0) queue.splice(i, 1);
			else queue[i] = { ...queue[i], options: rest };
		}
	}

	pi.on("before_agent_start", async (event) => {
		const addition = `
When a reply naturally ends with a choice or "say the word and I'll...", call the next_steps tool with 2-6 short option strings instead of asking in prose. Mark recommended options with rec (comma indices). Use subtitles when a label alone is ambiguous.`;
		let sp = (event.systemPrompt ?? "") + addition;
		if (settings.carryForward && queue.length > 0) {
			const carried = queue
				.map((q) => `[${q.age === 1 ? "1 reply" : `${q.age} replies`} back] ${q.options.join(" | ")}`)
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
			replyCounter++;
			for (const st of states) {
				const rest = withoutPicked(st);
				if (rest.options.length === 0) continue;
				const key = keyOf(rest.options);
				if (queue.some((q) => q.age === 0 && keyOf(q.options) === key)) continue;
				queue.unshift({ ...rest, age: 0, reply: replyCounter });
			}
			while (queue.length > 30) queue.pop();
			// States are per reply; the queue is the only place a block survives.
			states = [];
			pickedThisTurn.clear();
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
					for (const c of chosen) pickedThisTurn.add(c);
					retirePicked(chosen);
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
		if (queue.length === 0) {
			ctx.ui.notify("No next steps registered. Ask the agent to call next_steps.", "warning");
			return;
		}
		// One tab per collected block, newest first. Carried blocks keep their real age.
		const blocks = queue.map((q) => {
			const recSet = new Set((q.rec || "").split(",").map((s) => s.trim()));
			const riskySet = new Set((q.risky || "").split(",").map((s) => s.trim()));
			return {
				age: q.age,
				items: q.options.map((o, i) => {
					const tags = [
						settings.accentRecommended && recSet.has(String(i + 1)) ? "★" : "",
						settings.markRisky && riskySet.has(String(i + 1)) ? "▲" : "",
					].filter(Boolean).join(" ");
					return { option: o, text: `${tags ? tags + " " : ""}${o}` };
				}),
			};
		});
		const tabLabel = (i: number) =>
			i === 0 ? "this reply" : blocks[i].age === 1 ? "1 reply back" : `${blocks[i].age} replies back`;
		let chosen: string[] | null = null;
		try {
			chosen = await ctx.ui.custom<string[] | null>((tui, theme, _kb, done) => {
				let tab = 0;
				let cursor = 0;
				const picked = new Set<string>();
				const component = {
					focused: true,
					render(_width: number): string[] {
						const out: string[] = [];
						const head = blocks
							.map((_, i) =>
								i === tab ? theme.fg("accent", `[${tabLabel(i)}]`) : theme.fg("dim", ` ${tabLabel(i)} `),
							)
							.join(" · ");
						out.push(`${theme.fg("accent", "Next steps")}  ${head}`);
						blocks[tab].items.forEach((item, i) => {
							const mark = picked.has(`${tab}:${i}`) ? "[x]" : "[ ]";
							const prefix = i === cursor ? theme.fg("accent", "> ") : "  ";
							out.push(`${prefix}${mark} ${item.text}`);
						});
						out.push(theme.fg("dim", "space toggle · ↑↓ move · ←→ block · enter/tab confirm · esc cancel"));
						return out;
					},
					invalidate() {},
					handleInput(data: string) {
						const n = blocks[tab].items.length;
						if (matchesKey(data, "up") || matchesKey(data, "k")) {
							cursor = (cursor - 1 + n) % n;
						} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
							cursor = (cursor + 1) % n;
						} else if (matchesKey(data, "left") || matchesKey(data, "h")) {
							tab = (tab - 1 + blocks.length) % blocks.length;
							cursor = 0;
						} else if (matchesKey(data, "right") || matchesKey(data, "l")) {
							tab = (tab + 1) % blocks.length;
							cursor = 0;
						} else if (matchesKey(data, "space")) {
							const k = `${tab}:${cursor}`;
							if (picked.has(k)) picked.delete(k);
							else picked.add(k);
						} else if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
							done(
								Array.from(picked).map((k) => {
									const [b, i] = k.split(":").map(Number);
									return blocks[b].items[i].option;
								}),
							);
							return;
						} else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
							done(null);
							return;
						}
						tui.requestRender();
					},
				};
				return component;
			});
		} catch {
			ctx.ui.notify("Selection UI unavailable in this session.", "warning");
			return;
		}
		if (!chosen || chosen.length === 0) {
			ctx.ui.notify("No selection", "info");
			return;
		}
		// Every picked step travels as one user message, never one message per step.
		const message = chosen.length === 1 ? chosen[0] : chosen.map((c) => `- ${c}`).join("\n");
		if (ctx.isIdle()) {
			pi.sendUserMessage(message);
		} else if (settings.steerOnClick) {
			pi.sendUserMessage(message, { deliverAs: "steer" });
		} else {
			pi.sendUserMessage(message, { deliverAs: "followUp" });
		}
		retirePicked(chosen);
		ctx.ui.notify(`Sent ${chosen.length} step(s)`, "info");
	}

	// `/ns clear` drops everything older than the newest reply; `/ns clear X` drops the last X posts.
	async function clearSteps(arg: string, ctx: any) {
		const trimmed = arg.trim();
		if (queue.length === 0) {
			ctx.ui.notify("No collected next steps to clear.", "info");
			return;
		}
		if (/^clear$/i.test(trimmed)) {
			const before = queue.length;
			const newest = queue[0].reply;
			for (let i = queue.length - 1; i >= 0; i--) {
				if (queue[i].reply < newest) queue.splice(i, 1);
			}
			const dropped = before - queue.length;
			ctx.ui.notify(
				dropped > 0
					? `Cleared ${dropped} stale step(s). Kept the newest reply.`
					: "Nothing stale to clear. Use /ns clear X for the last X posts.",
				"info",
			);
			return;
		}
		const m = trimmed.match(/^clear\s+(\d+)$/i);
		if (m) {
			const n = parseInt(m[1], 10);
			if (n < 1) {
				ctx.ui.notify("Usage: /ns clear [X]", "warning");
				return;
			}
			const cutoff = replyCounter - n + 1;
			const before = queue.length;
			for (let i = queue.length - 1; i >= 0; i--) {
				if (queue[i].reply >= cutoff) queue.splice(i, 1);
			}
			const dropped = before - queue.length;
			ctx.ui.notify(
				dropped > 0
					? `Cleared ${dropped} step(s) from the last ${n} post(s).`
					: `No collected steps in the last ${n} post(s).`,
				"info",
			);
			return;
		}
		ctx.ui.notify("Usage: /ns clear (stale) or /ns clear X (last X posts)", "warning");
	}

	const runOrClear = async (args: string, ctx: any) => {
		const a = (args ?? "").trim();
		if (!a) return pickAndSend(ctx);
		if (/^clear\b/i.test(a) || /^clear$/i.test(a)) return clearSteps(a, ctx);
		ctx.ui.notify("Usage: /ns or /ns clear [X]", "warning");
	};

	pi.registerCommand("ns", {
		description: "Pick and send a registered next step, or /ns clear [X] to drop collected steps.",
		handler: async (args, ctx) => runOrClear(args, ctx),
	});
	pi.registerCommand("nextsteps", {
		description: "Pick and send a registered next step, or /nextsteps clear [X] to drop collected steps.",
		handler: async (args, ctx) => runOrClear(args, ctx),
	});
	pi.registerCommand("nextsteps-settings", {
		description: "Show next-steps settings path.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Settings: ${SETTINGS_PATH}`, "info");
		},
	});
}
