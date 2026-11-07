// A control that goes off (disabled, or inert with its block) while it holds the focus loses it to the body, and a browser does not give it back. `keepFocus` runs the change and remembers such a control (as ask.ts does for its panel); the next
// call on the same scope gives it the focus again when it is on and the focus is still on the body. The boss's focus or press anywhere else forgets it. Only one control holds the focus at a time, so one is remembered.

let lost: HTMLElement | undefined, armed = false;
const idle = () => !document.activeElement || document.activeElement === document.body;
const off = (el: HTMLElement) => (el as HTMLButtonElement).disabled === true || el.closest("[inert]") !== null;

export function keepFocus(scope: HTMLElement, change: () => void): void {
	if (!armed) {
		armed = true;
		for (const type of ["focusin", "pointerdown"]) document.addEventListener(type, (e) => lost && e.target !== lost && (lost = undefined)); // the boss went elsewhere
	}
	const had = document.activeElement as HTMLElement | null;
	change();
	if (had && had !== document.body && scope.contains(had) && off(had)) lost = had;
	if (lost && scope.contains(lost) && !off(lost) && idle()) (lost.focus(), (lost = undefined));
}
