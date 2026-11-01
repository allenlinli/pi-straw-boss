import { h } from "./dom.ts";
import { getLocale } from "./paraglide/runtime.js";

// The lines under the idle circle (docs/specs/2026-11-01-zen-view.md): one short mindfulness line at a time, each with whom it comes from, fading to the next.
// The boss wants lines that people really said or taught, so each carries its source in `by`. The deck shows every line once, in a random order, before any repeats.

export interface Line { zh: string; en: string; by: string }

// Real lines, each with its source (one sentence or less, attributed). `zh: published` is wording printed or posted by the source in Chinese; `zh: our translation` is ours from the English original;
// `en: our translation` marks a Chinese original that we put into English. The list and its checks: scratch quotes.md of the Z4 round (credited in NOTICE.md).
export const LINES: readonly Line[] = [
	// Peace Is Every Step (1991), "Present Moment Wonderful Moment"; zh: published (橡實文化, 方怡蓉譯)
	{ zh: "吸氣，我讓身體平靜。", en: "Breathing in, I calm my body.", by: "一行禪師 / Thich Nhat Hanh" },
	// Peace Is Every Step, same chapter; zh: published
	{ zh: "呼氣，我微笑。", en: "Breathing out, I smile.", by: "一行禪師 / Thich Nhat Hanh" },
	// Peace Is Every Step, same chapter; zh: published (the chapter's title in the 橡實 edition)
	{ zh: "當下此刻最美妙", en: "Present moment, wonderful moment.", by: "一行禪師 / Thich Nhat Hanh" },
	// Peace Is Every Step, "Conscious Breathing"; zh: our translation
	{ zh: "吸氣，我知道我在吸氣", en: "Breathing in, I know that I am breathing in.", by: "一行禪師 / Thich Nhat Hanh" },
	// Peace Is Every Step, "Twenty-Four Brand-New Hours" (cut of a longer sentence); zh: our translation
	{ zh: "平靜就在此時此地", en: "Peace is present right here and now.", by: "一行禪師 / Thich Nhat Hanh" },
	// Mindful.org, "Practice the RAIN Meditation with Tara Brach", step A; zh: our translation
	{ zh: "讓生活如其所是", en: "Allow life to be just as it is.", by: "Tara Brach" },
	// Mindful.org, the same page, step R; zh: our translation
	{ zh: "覺察正在發生的事", en: "Recognize what is happening.", by: "Tara Brach" },
	// sharonsalzberg.com, the site's lovingkindness line; zh: our translation
	{ zh: "願你平安、快樂、健康、自在", en: "May you be safe, be happy, be healthy, live with ease.", by: "Sharon Salzberg" },
	// mindful.org/how-to-meditate, step 6; zh: our translation
	{ zh: "對走神的心溫柔一點", en: "Be kind to your wandering mind.", by: "Mindful.org" },
	// mindful.org/how-to-meditate, the end of step 6; zh: our translation
	{ zh: "回來就好", en: "Just come back.", by: "Mindful.org" },
	// mindful.org/how-to-meditate, step 5; zh: our translation
	{ zh: "留意到心走神了", en: "Notice when your mind has wandered.", by: "Mindful.org" },
	// mindfulness.com.tw, "正念定義：非評價的澄清與解析" (a cut of its sentence); zh: published; en: our translation
	{ zh: "安然與自己同在，與當下同在", en: "Be at ease with yourself, with this moment.", by: "華人正念減壓中心 / Taiwan MBSR Center" },
	// Firstory, "EP1 正念靜心3分鐘" (台灣正念工坊); zh: published; en: our translation
	{ zh: "讓你的心回到身體裡，回到當下", en: "Let your mind come back to your body, to now.", by: "陳德中 / Chen Te-chung" },
	// Firstory, the same episode's text; zh: published; en: our translation
	{ zh: "暫時放下一切，與自己在一起", en: "Set everything down for a while; be with yourself.", by: "台灣正念工坊 / Taiwan Mindfulness Center" },
];

/** A shuffled deck over `count` lines: `next()` is the index to show, and none repeats until all have been shown (the first of a new round is never the last of the old one). */
export function deck(count: number, random: () => number = Math.random) {
	let order: number[] = [], last = -1;
	const shuffle = () => {
		order = Array.from({ length: count }, (_, i) => i);
		for (let i = count - 1; i > 0; i--) {
			const j = Math.floor(random() * (i + 1));
			[order[i], order[j]] = [order[j]!, order[i]!];
		}
		if (count > 1 && order[order.length - 1] === last) [order[0], order[order.length - 1]] = [order[order.length - 1]!, order[0]!]; // `next` takes from the end
	};
	return {
		next() {
			if (count === 0) return -1;
			if (order.length === 0) shuffle();
			return (last = order.pop()!);
		},
	};
}

/** The line in the page's language, and its source named in it too (`by` reads "中文名 / English name" when the source has both). */
export const textOf = (line: Line) => (getLocale() === "zh-TW" ? line.zh : line.en);
export const byOf = (line: Line) => line.by.split(" / ")[getLocale() === "zh-TW" ? 0 : 1] ?? line.by;

export const LINE_MS = 45_000, FADE_MS = 1600;
/** Whether the page holds still: the reduced-motion setting, or the calm that follows 30 s without input (calm.ts). */
export const stillNow = () => (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) || Boolean(document.documentElement?.hasAttribute("data-calm"));

/** The line under the idle circle: it shows one line now and, every LINE_MS, fades to the next (never one already shown until all were). While the page holds still it stays as it is. `stop` cancels the timers. */
export function mountLine(later: (fn: () => void, ms: number) => () => void, still: () => boolean = stillNow, random: () => number = Math.random, lines: readonly Line[] = LINES) {
	const cards = deck(lines.length, random), text = h("span", { class: "zen-line-text" }), by = h("small", { class: "zen-line-by" }), el = h("p", { class: "zen-line" }, text, by);
	let cancel = () => {};
	const put = () => {
		const line = lines[cards.next()];
		if (!line) return;
		text.textContent = textOf(line);
		by.textContent = byOf(line);
	};
	const wait = () => (cancel = later(() => {
		if (still()) return wait();
		el.dataset.fading = "";
		cancel = later(() => (put(), delete el.dataset.fading, wait()), FADE_MS);
	}, LINE_MS));
	put();
	wait();
	return { el, stop: () => cancel() };
}
