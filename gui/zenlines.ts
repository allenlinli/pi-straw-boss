import { h } from "./dom.ts";
import { getLocale } from "./paraglide/runtime.js";

// The lines under the idle circle (docs/specs/2026-11-01-zen-view.md): one short mindfulness line at a time, each with whom it comes from, fading to the next.
// The boss wants lines that people really said or taught, so each carries its source in `by`. The deck shows every line once, in a random order, before any repeats.

/** `ja` is the Japanese original, set small under the source when the line was written in Japanese; the other sources have none. */
export interface Line { zh: string; en: string; by: string; ja?: string }

// Real lines, each with its source (one sentence or less, attributed). `zh: published` is wording printed or posted by the source in Chinese; `zh: our translation` is ours from the English original;
// `en: our translation` marks a Chinese original that we put into English, and a Japanese original (`ja:`, shown small under the source) is put into both languages by us. The list and its checks: scratch quotes.md of the Z4 round (credited in NOTICE.md).
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
	// Bashō, haiku, first printed in 蛙合 and 春の日 (both 1686); ja: the standard text; zh: our translation; en: our translation
	{ zh: "古池，青蛙躍入，水聲一響", en: "An old pond: a frog jumps in, and the sound of water.", by: "松尾芭蕉 / Matsuo Bashō", ja: "古池や蛙飛びこむ水の音" },
	// Bashō, おくのほそ道 (the Yamadera section); ja: the standard text (the travel diary has an earlier form); zh: our translation; en: our translation
	{ zh: "靜寂，蟬聲滲入岩石", en: "Stillness: the cicadas' cry sinks into the rock.", by: "松尾芭蕉 / Matsuo Bashō", ja: "閑さや岩にしみ入る蝉の声" },
	// Bashō, おくのほそ道, the opening sentence (Wikisource, from the 1911 print); ja: in modern spelling (行きかふ, 也 as なり); zh: our translation; en: our translation
	{ zh: "歲月是百代過客，來去的年歲也是旅人", en: "The months and days are travellers of a hundred ages; the years that come and go are travellers too.", by: "松尾芭蕉 / Matsuo Bashō", ja: "月日は百代の過客にして、行きかふ年も又旅人なり。" },
	// Yosa Buson, haiku of 1774 (安永3), in 蕪村句集 (1784, spring); ja: the standard text; zh: our translation; en: our translation
	{ zh: "油菜花開，月在東，日在西", en: "Mustard flowers; the moon in the east, the sun in the west.", by: "與謝蕪村 / Yosa Buson", ja: "菜の花や月は東に日は西に" },
	// Yosa Buson, haiku, in 蕪村句集 (1784, spring); ja: the standard text; zh: our translation; en: our translation
	{ zh: "春天的海，整日一起一伏，悠悠緩緩", en: "The spring sea, rising and falling slowly, slowly, all day long.", by: "與謝蕪村 / Yosa Buson", ja: "春の海終日のたりのたりかな" },
	// Kobayashi Issa, haiku of early spring 1814 (文化11); ja: the standard text; zh: our translation; en: our translation
	{ zh: "雪融了，村裡滿是孩子", en: "The snow melts, and the village is full of children.", by: "小林一茶 / Kobayashi Issa", ja: "雪とけて村いっぱいの子どもかな" },
	// Kobayashi Issa, haiku in 七番日記 (the diary's draft reads あの月を); ja: the standard text; zh: our translation; en: our translation
	{ zh: "孩子哭著要我摘下那輪明月", en: "A child cries for me to take down the harvest moon.", by: "小林一茶 / Kobayashi Issa", ja: "名月を取ってくれろと泣く子かな" },
	// Kamo no Chōmei, 方丈記, the opening sentence (Aozora Bunko card 975); ja: Aozora's text; zh: our translation; en: our translation
	{ zh: "河水流逝不絕，卻已不是原來的水", en: "The flowing river never stops, and yet the water is never the same.", by: "鴨長明 / Kamo no Chōmei", ja: "行く川のながれは絶えずして、しかも本の水にあらず。" },
	// Yoshida Kenkō, 徒然草 dan 137, the first sentence (a rhetorical question); ja: the standard text; zh: our translation; en: our translation
	{ zh: "花，只看盛開時？月，只看無雲時？", en: "Must we look at blossoms only in full bloom, at the moon only when no cloud hides it?", by: "吉田兼好 / Yoshida Kenkō", ja: "花は盛りに、月は隈なきをのみ、見るものかは。" },
	// Yoshida Kenkō, 徒然草 dan 19, the first sentence; ja: the standard text; zh: our translation; en: our translation
	{ zh: "時節遞嬗，萬事皆有動人之處", en: "As the seasons turn, everything has something that moves us.", by: "吉田兼好 / Yoshida Kenkō", ja: "折節の移り変るこそ、ものごとにあはれなれ。" },
	// Sei Shōnagon, 枕草子 dan 1 (Wikisource), cut after 山ぎは, where the sentence goes on to the clouds; ja: the standard text; zh: our translation; en: our translation
	{ zh: "春天，最好是破曉，山邊漸漸泛白", en: "In spring, the dawn: the edge of the mountains slowly turning white.", by: "清少納言 / Sei Shōnagon", ja: "春はあけぼの。やうやう白くなりゆく山ぎは" },
	// Fujiwara no Teika, a waka in 新古今和歌集 (no. 363); ja: the standard text; zh: our translation; en: our translation
	{ zh: "花也無，紅葉也無，浦上茅屋的秋暮", en: "No blossoms, no autumn leaves: a thatched hut on the shore at autumn dusk.", by: "藤原定家 / Fujiwara no Teika", ja: "見渡せば花も紅葉もなかりけり浦の苫屋の秋の夕暮" },
	// Ki no Tomonori, a waka in 古今和歌集 (no. 84) and 小倉百人一首 (no. 33); ja: the standard text; zh: our translation; en: our translation
	{ zh: "春日光和，花何以匆匆飄落", en: "In the soft light of a spring day, why do the blossoms fall with so restless a heart?", by: "紀友則 / Ki no Tomonori", ja: "ひさかたの光のどけき春の日にしづ心なく花の散るらむ" },
	// Yamabe no Akahito, a waka in 万葉集 (book 3, no. 318), cut after the first half (見れば), where the poem turns to the snow; ja: the Nara Manyo Culture Museum database's reading; zh: our translation; en: our translation
	{ zh: "富士高嶺上，雪正落得一片潔白", en: "On the high peak of Fuji, the snow was falling pure white.", by: "山部赤人 / Yamabe no Akahito", ja: "真白にそ富士の高嶺に雪は降りける" },
	// Dōgen, a waka in 傘松道詠 (面山's print reads すずしかりけり; 冷しかりけり is the common later form, as in Kawabata's Nobel lecture); ja: 涼し, the modern spelling; zh: our translation; en: our translation
	{ zh: "春花，夏有杜鵑啼，秋月，冬雪澄澈", en: "Spring, the blossoms; summer, the cuckoo; autumn, the moon; winter, snow clear and cool.", by: "道元 / Dōgen", ja: "春は花夏ほととぎす秋は月冬雪さえて涼しかりけり" },
	// Sen no Rikyū (traditionally), 利休百首, the waka as Urasenke prints it (urasenke.or.jp, 茶の湯の心: のむ in kana); the hundred poems took their present form after his time; ja: Urasenke's text; zh: our translation; en: our translation
	{ zh: "茶之湯，不過是燒水、點茶、喝茶", en: "Tea is only this: boil the water, make the tea, and drink it.", by: "利休百首 / Rikyū Hyakushu", ja: "茶の湯とはただ湯をわかし茶を点ててのむばかりなることと知るべし" },
	// Ii Naosuke, 茶湯一会集 (about 1858), the 一期一会 passage, cut at 也; ja: the text quoted by seishian.com in modern kana; zh: our translation; en: our translation
	{ zh: "今日之會不再重來，實是一生一次", en: "Today's gathering will never come again; it is truly once in a lifetime.", by: "井伊直弼 / Ii Naosuke", ja: "今日の会にふたたびかへらざる事を思へば、実に我一世一度の会也。" },
	// Tanizaki Jun'ichirō, 陰翳礼讃 (Aozora Bunko card 56642), the end of a sentence, cut at 美は; ja: Aozora's text; zh: our translation; en: our translation
	{ zh: "美不在物，在物與物間的陰翳與明暗", en: "Beauty lies not in the thing itself but in the play of shadow and light that things make between them.", by: "谷崎潤一郎 / Tanizaki Jun'ichirō", ja: "美は物体にあるのではなく、物体と物体との作り出す陰翳のあや、明暗にあると考える。" },
	// Masaoka Shiki, haiku of the winter of 1896 (明治29); ja: the standard text; zh: our translation; en: our translation
	{ zh: "一次又一次，問雪積得多深", en: "Again and again I ask how deep the snow lies.", by: "正岡子規 / Masaoka Shiki", ja: "いくたびも雪の深さを尋ねけり" },
	// Natsume Sōseki, haiku sent to Shiki in 1897 (明治30); ja: the standard text; zh: our translation; en: our translation
	{ zh: "願生為像堇菜花那麼小的人", en: "Would that I were born as small a person as a violet.", by: "夏目漱石 / Natsume Sōseki", ja: "菫程な小さき人に生れたし" },
	// Taneda Santōka, 草木塔 (Aozora Bunko card 749), the haiku of 1926; ja: Aozora's text; zh: our translation; en: our translation
	{ zh: "走進去，再走進去，仍是青山", en: "Going in, and going further in: green mountains still.", by: "種田山頭火 / Taneda Santōka", ja: "分け入つても分け入つても青い山" },
	// Taneda Santōka, 草木塔 (Aozora Bunko card 749); ja: Aozora's text; zh: our translation; en: our translation
	{ zh: "走進去，便聽見水聲", en: "Going in, there is the sound of water.", by: "種田山頭火 / Taneda Santōka", ja: "分け入れば水音" },
	// Zen Mind, Beginner's Mind (Weatherhill, 1970), the Prologue's epigraph; zh: our translation; en: published
	{ zh: "初學者的心有許多可能，專家的心很少", en: "In the beginner's mind there are many possibilities, but in the expert's there are few.", by: "鈴木俊隆 / Shunryu Suzuki" },
	// Zen Mind, Beginner's Mind (Weatherhill, 1970), "Breathing" (the whole sentence); zh: our translation; en: published
	{ zh: "空氣進出，如人穿過一扇擺動的門", en: "The air comes in and goes out like someone passing through a swinging door.", by: "鈴木俊隆 / Shunryu Suzuki" },
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
	const cards = deck(lines.length, random), text = h("span", { class: "zen-line-text" }), by = h("small", { class: "zen-line-by" }), ja = h("small", { class: "zen-line-ja", lang: "ja" }), el = h("p", { class: "zen-line" }, text, by, ja);
	let cancel = () => {};
	const put = () => {
		const line = lines[cards.next()];
		if (!line) return;
		text.textContent = textOf(line);
		by.textContent = byOf(line);
		ja.textContent = line.ja ?? "";
		ja.hidden = !line.ja;
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
