import { reportPeek, type UnitCard } from "./linkmodel.ts";
import { m } from "./paraglide/messages.js";
import { ago, html, sync, text } from "./render.ts";

// What an unattended device says about its units, as the card of its ally base draws it (docs/how-it-works.md, Unattended devices; the holder's `unit-status`): per unit a state word with how long ago the box said it, its monitors on one
// line, the last report folded to its first line (a tap opens it as Markdown), and, when a notice told of a crash lately, "crashed" with the notice behind a fold. Every word of a unit is a teammate's, so it only becomes text (the report goes
// through the page's Markdown, which parses no HTML). The report's Markdown is made when the fold first opens, in a chunk of its own, and again while it is open when the report changes.

type Row = UnitCard & { id: string; named: boolean };
const make = () => html(`<li class="ally-unit"><div class="au-head"><i class="au-dot"></i><b class="au-word"></b><span class="au-name"></span><span class="au-time" hidden><span class="au-pre"></span><span class="age"></span><span class="au-ago"></span></span><em class="au-stale" hidden></em></div><p class="au-mons" hidden><b></b><span></span></p><details class="au-crash" hidden><summary><b></b><span class="au-time"><span class="age"></span><span class="au-ago"></span></span></summary><pre></pre></details><details class="au-report" hidden><summary><b class="au-label"></b><span class="au-peek"></span></summary><div class="md au-md"></div></details></li>`);

type Markdown = typeof import("./markdown.ts");
let markdown: Markdown | undefined;
const reports = new WeakMap<HTMLElement, string>();
/** Makes the folded report's Markdown when the fold is open and what it shows is not the report. */
function paint(fold: HTMLDetailsElement) {
	const body = fold.querySelector<HTMLElement>(".au-md")!, report = reports.get(fold) ?? "";
	if (!fold.open || body.dataset.report === report) return;
	void (markdown ? Promise.resolve(markdown) : import("./markdown.ts").then((x) => (markdown = x))).then(({ mount, parse }) => {
		if (!fold.open || reports.get(fold) !== report) return;
		body.dataset.report = report;
		body.replaceChildren(mount(parse(report)));
	});
}
/** A time as "40s ago" (the page's clock keeps it current, `mountPage`), with the words before and after it when the line says what the time is of ("updated 40s ago", "40 秒前更新"). */
function clock(box: HTMLElement, since: number, pre = "", post = m.link_unit_ago()) {
	const age = box.querySelector<HTMLElement>(".age")!;
	age.dataset.since = String(since);
	age.textContent = ago(since);
	box.querySelector<HTMLElement>(".au-pre")?.replaceChildren(pre);
	box.querySelector<HTMLElement>(".au-ago")!.textContent = post;
}

/** Draws the units of one ally base. `named`: the base is a whole device (no workspace of its own), so a unit says its name; otherwise the card's title is the unit. */
export function fillAllyUnits(list: Element, cards: UnitCard[], named: boolean) {
	sync(list, cards.map((u) => ({ ...u, id: u.unit, named })) as Row[], make, (li, u) => {
		li.dataset.state = u.state;
		li.dataset.tone = u.tone;
		li.classList.toggle("stale", u.stale);
		text(li, ".au-word", u.word);
		text(li, ".au-name", u.named ? u.unit : "");
		const time = li.querySelector<HTMLElement>(".au-head > .au-time")!;
		time.hidden = false;
		time.title = m.link_unit_heard();
		clock(time, u.at, m.link_unit_updated_pre(), m.link_unit_updated_post());
		const stale = li.querySelector<HTMLElement>(".au-stale")!;
		stale.hidden = !u.stale;
		stale.textContent = u.stale ? m.link_unit_stale() : "";
		stale.title = u.stale ? m.link_unit_stale_title() : "";
		const mons = li.querySelector<HTMLElement>(".au-mons")!;
		mons.hidden = !u.monitors.length;
		if (u.monitors.length) {
			text(mons, "b", m.link_unit_monitors({ count: u.monitors.length }));
			text(mons, "span", u.monitors.join(" · "));
			mons.title = u.monitors.join("\n");
		}
		const crash = li.querySelector<HTMLDetailsElement>(".au-crash")!;
		crash.hidden = !u.crash;
		if (u.crash) {
			text(crash, "summary > b", m.link_unit_crash());
			clock(crash.querySelector<HTMLElement>("summary > .au-time")!, u.crash.at);
			text(crash, "pre", u.crash.text);
		}
		const fold = li.querySelector<HTMLDetailsElement>(".au-report")!;
		fold.hidden = !u.report;
		if (!u.report) return;
		text(fold, ".au-label", m.link_unit_report());
		text(fold, ".au-peek", reportPeek(u.report));
		reports.set(fold, u.report);
		fold.ontoggle = () => paint(fold);
		paint(fold);
	});
}
