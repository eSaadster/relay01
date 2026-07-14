import type { Scratchpad } from "./pi-agent-scratchpad.js";

/**
 * Build a feedback note from a 👍/👎 reaction and apply it to a scratchpad's
 * critical[] memory. Deduplicates identical notes (moving the note to the
 * front) and caps the critical list at 20 items, keeping the newest first.
 */
export function applyFeedbackToScratchpad(sp: Scratchpad, positive: boolean, text: string): Scratchpad {
	const snippet = text.slice(0, 160).replace(/\s+/g, " ").trim();
	const note = positive
		? '👍 User approved this kind of response: "' + snippet + '"'
		: '👎 User disliked this response — avoid repeating: "' + snippet + '"';
	const critical = [note, ...sp.critical.filter((c) => c !== note)].slice(0, 20);
	return { ...sp, critical };
}
