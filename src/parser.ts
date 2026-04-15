import type { Page } from "./pagepool.ts";

type IExamples = string[];

type IDefinitions = Record<
	string,
	{
		definition: string;
		example?: string;
		labels?: string[];
		synonyms?: Record<string, string[]>;
	}[]
>;

type ITranslations = Record<
	string,
	{
		translation: string;
		reversedTranslations: string[];
		frequency: string;
	}[]
>;

export const parsePage = async (
	page: Page,
	{
		text,
		from,
		to,
		lite,
	}: {
		text: string;
		from: string;
		to: string;
		lite: boolean;
	},
) => {
	const textareaSelector = "textarea[aria-label='Source text']";
	const visibleLanguages = await page.evaluate(
		(fromCode, toCode) => {
			const visibleTablists = Array.from(
				document.querySelectorAll<HTMLElement>('[role="tablist"]'),
			).filter((tablist) =>
				tablist.querySelectorAll("button[data-language-code]").length > 0
			);
			const sourceTablist = visibleTablists[0];
			const targetTablist = visibleTablists[1];

			return {
				hasSource: Boolean(
					sourceTablist?.querySelector(
						`button[data-language-code="${fromCode}"]`,
					),
				),
				hasTarget: Boolean(
					targetTablist?.querySelector(
						`button[data-language-code="${toCode}"]`,
					),
				),
			};
		},
		from,
		to,
	);

	if (!visibleLanguages.hasSource || !visibleLanguages.hasTarget) {
		const params = new URLSearchParams({
			sl: from,
			tl: to,
			op: "translate",
		});
		await page.goto(
			`https://translate.google.com/details?${params.toString()}`,
			{
				waitUntil: "networkidle2",
			},
		);
	}

	// click clear button when available so we start from a clean source field
	await page.$eval(
		"button[aria-label='Clear source text']",
		(btn) => (btn as HTMLButtonElement).click(),
	).catch(() => {});

	// switch source and target language
	await page.evaluate(
		(fromCode, toCode) => {
			const visibleTablists = Array.from(
				document.querySelectorAll<HTMLElement>('[role="tablist"]'),
			).filter((tablist) =>
				tablist.querySelectorAll("button[data-language-code]").length > 0
			);
			const sourceTablist = visibleTablists[0];
			const targetTablist = visibleTablists[1];
			const sourceButton = sourceTablist?.querySelector<HTMLElement>(
				`button[data-language-code="${fromCode}"]`,
			);
			const targetButton = targetTablist?.querySelector<HTMLElement>(
				`button[data-language-code="${toCode}"]`,
			);

			if (
				sourceButton && sourceButton.getAttribute("aria-selected") !== "true"
			) {
				sourceButton.click();
			}
			if (
				targetButton && targetButton.getAttribute("aria-selected") !== "true"
			) {
				targetButton.click();
			}
		},
		from,
		to,
	);

	// type text like a real user so Google Translate reacts on reused pages
	await page.click(textareaSelector, { clickCount: 3 });
	await page.keyboard.press("Backspace");
	await page.type(textareaSelector, text);

	// translating...
	let result = "";
	let pronunciation = "";
	do {
		const targetTextareaSelector = `textarea[lang="${to}"]`;
		await page.waitForFunction(
			(targetTextareaSelector) => {
				const targetTextarea = document.querySelector(targetTextareaSelector);
				return targetTextarea instanceof HTMLTextAreaElement &&
					targetTextarea.value.trim() !== "";
			},
			{},
			targetTextareaSelector,
		);

		// get translated text
		result += await page.evaluate(
			(targetTextareaSelector, to) => {
				const targetTextarea = document.querySelector(targetTextareaSelector);
				if (
					targetTextarea instanceof HTMLTextAreaElement &&
					targetTextarea.value.trim() !== ""
				) {
					return targetTextarea.value.replace(/[\u200B-\u200D\uFEFF]/g, "");
				}

				return Array.from(
					document.querySelectorAll<HTMLElement>(
						`span.HwtZe[lang="${to}"] .ryNqvb`,
					),
				)
					.map((s) => s.innerText.replace(/[\u200B-\u200D\uFEFF]/g, ""))
					.join("");
			},
			targetTextareaSelector,
			to,
		);

		// get pronunciation
		pronunciation += (await page.evaluate(() =>
			document
				.querySelector<HTMLElement>('div[data-location="2"] > div')
				?.innerText?.replace(/[\u200B-\u200D\uFEFF]/g, "")
		)) || "";

		// get next page
		const shouldContinue = await page.evaluate(() => {
			const next = document.querySelector('button[aria-label="Next"]');
			const pseudoNext = getComputedStyle(
				document.querySelector('button[aria-label="Next"] > div')!,
				"::before",
			);
			const hasNext = next && pseudoNext.width.endsWith("px") &&
				pseudoNext.width !== "0px";
			const isLastPage = next?.hasAttribute("disabled");
			const shouldContinue = Boolean(hasNext && !isLastPage);
			return shouldContinue;
		});

		if (shouldContinue) {
			// await network idle first
			const xhr = page.waitForResponse((r) => {
				return r
					.url()
					.startsWith(
						"https://translate.google.com/_/TranslateWebserverUi/data/batchexecute",
					);
			});

			await page.evaluate(() => {
				const next = document.querySelector<HTMLButtonElement>(
					'button[aria-label="Next"]',
				)!;
				next.click();
			});

			await xhr;
		} else {
			break;
		}
	} while (true);

	// get from
	// const fromISO = await page.evaluate(() =>
	// 	document
	// 		.querySelector<HTMLElement>("div[data-original-language]")!
	// 		.getAttribute("data-original-language")
	// );
	// [TODO] when it's auto, we need to get real "from" otherwise the "examples" won't work
	// here is the script to get all the iso codes and their names
	// [...window.document.querySelectorAll("div[data-language-code]")].map(e => ({
	//     code: e.getAttribute("data-language-code"),
	//     name: e.innerText.trim(),
	// })).filter(e => e.code && !e.code.includes("history"))

	if (!lite) {
		await page
			.waitForFunction(() => {
				const details = document.querySelector("c-wiz[role='complementary']");
				return Boolean(
					details?.textContent?.includes("No details found for") ||
						details?.textContent?.includes("Enter text to look up details") ||
						document.querySelector("h3.FpSDVb"),
				);
			}, { timeout: 5000 })
			.catch(() => {});
	}

	const {
		fromDidYouMean,
		fromSuggestions,
		fromPronunciation,
		examples,
		definitions,
		translations,
	} = await page.evaluate(
		(from, to, lite, isAuto) => {
			const clean = (value?: string | null) =>
				value
					?.replace(/[\u200B-\u200D\uFEFF]/g, "")
					.replace(/\s+/g, " ")
					.trim();
			const normalizePronunciation = (value?: string | null) => {
				const normalized = clean(value);
				if (
					!normalized ||
					["Listen", "Loading", "Show more", "Show less"].some((token) =>
						normalized.includes(token)
					)
				) {
					return undefined;
				}
				return normalized;
			};
			const headings = Array.from(
				document.querySelectorAll<HTMLElement>("h3.FpSDVb"),
			);
			const getSectionByTitle = (title: string) =>
				headings.find((heading) => heading.innerText.startsWith(title))
					?.parentElement;
			const resolvedFrom = (isAuto
				? document
					.querySelector<HTMLElement>('div[data-location="5"]')
					?.getAttribute("data-language-code") ??
					document
						.querySelector<HTMLElement>(".vvvYne[lang]")
						?.getAttribute("lang")
				: from) ?? from;

			const didYouMeanBlock = Array.from(
				document.querySelectorAll<HTMLElement>("html-blob"),
			).find((block) =>
				["Did you mean:", "Showing translation for"].some((text) =>
					block.parentElement?.parentElement?.innerHTML.includes(text)
				)
			);

			const rawSuggestions = lite || isAuto ? undefined : Array.from(
				document.querySelectorAll<HTMLElement>('ul[role="listbox"] > li'),
			)
				.map((suggestion) => {
					const text = clean(
						suggestion.querySelector<HTMLElement>(`[lang="${from}"]`)
							?.innerText,
					);
					const translation = clean(
						suggestion.querySelector<HTMLElement>(`[lang="${to}"]`)
							?.innerText,
					);

					return text ? { text, translation: translation ?? "" } : undefined;
				})
				.filter((suggestion) => suggestion !== undefined);
			const fromSuggestions = rawSuggestions && rawSuggestions.length > 0
				? rawSuggestions
				: undefined;

			const fromPronunciation = normalizePronunciation(
				document.querySelector<HTMLElement>('div[data-location="1"]')
					?.innerText,
			);

			const detailsRoot = document.querySelector("c-wiz[role='complementary']");
			const noDetails =
				detailsRoot?.textContent?.includes("No details found for") ||
				detailsRoot?.textContent?.includes("Enter text to look up details");
			if (lite || noDetails) {
				return {
					fromDidYouMean: clean(didYouMeanBlock?.innerText),
					fromSuggestions,
					fromPronunciation,
					examples: undefined,
					definitions: undefined,
					translations: undefined,
				};
			}

			const definitionsSection = getSectionByTitle("Definitions of");
			const definitions: IDefinitions = {};
			if (definitionsSection) {
				let currentPartOfSpeech: string | undefined;
				for (
					const rawChild of Array.from(definitionsSection.children).slice(1)
				) {
					const child = rawChild.getAttribute("role") === "presentation" &&
							rawChild.firstElementChild instanceof HTMLElement
						? rawChild.firstElementChild
						: rawChild;

					if (child.matches(".pRq29d")) {
						currentPartOfSpeech = clean(child.textContent)?.toLowerCase();
						if (currentPartOfSpeech) {
							definitions[currentPartOfSpeech] = [];
						}
						continue;
					}

					if (!currentPartOfSpeech || !child.matches(".AVg9bf")) {
						continue;
					}

					const definitionBlock = child.querySelector<HTMLElement>(".ILf88");
					const definition = clean(
						definitionBlock
							?.querySelector<HTMLElement>(`div[lang="${resolvedFrom}"]`)
							?.textContent,
					);
					if (!definition) {
						continue;
					}

					const example = clean(definitionBlock?.querySelector("q")?.innerText);
					const labels = Array.from(
						definitionBlock?.querySelectorAll<HTMLElement>(
							".ILf88 > .nMdasd",
						) ??
							[],
					)
						.map((label) => clean(label.innerText))
						.filter((label): label is string => Boolean(label));
					const synonyms = Array.from(
						definitionBlock?.querySelectorAll<HTMLElement>(
							`ul.PwrFgb span[lang="${resolvedFrom}"]`,
						) ?? [],
					)
						.map((synonym) => clean(synonym.innerText))
						.filter((synonym): synonym is string => Boolean(synonym));

					definitions[currentPartOfSpeech].push({
						definition,
						...(example && { example }),
						...(labels.length > 0 && { labels }),
						...(synonyms.length > 0 && {
							synonyms: {
								common: synonyms,
							},
						}),
					});
				}
			}

			const examplesSection = getSectionByTitle("Examples of");
			const examples = examplesSection
				? Array.from(examplesSection.querySelectorAll<HTMLElement>(".lc69I"))
					.map((example) => clean(example.innerText))
					.filter((example): example is string => Boolean(example))
				: undefined;

			const translationsSection = getSectionByTitle("Translations of");
			const translations: ITranslations = {};
			if (translationsSection) {
				for (
					const tbody of Array.from(
						translationsSection.querySelectorAll<HTMLElement>("table tbody"),
					)
				) {
					const rows = Array.from(tbody.querySelectorAll("tr"));
					const partOfSpeech = clean(
						rows[0]
							?.querySelector<HTMLElement>('th[scope="rowgroup"] .WiGTJe')
							?.innerText,
					)?.toLowerCase();
					if (!partOfSpeech) {
						continue;
					}

					translations[partOfSpeech] = rows
						.map((row) => {
							const translation = clean(
								row.querySelector<HTMLElement>(`th[scope="row"] [lang="${to}"]`)
									?.innerText,
							);
							if (!translation) {
								return undefined;
							}

							return {
								translation,
								reversedTranslations: Array.from(
									row.querySelectorAll<HTMLElement>(
										`td ul [lang="${resolvedFrom}"]`,
									),
								)
									.map((item) => clean(item.innerText))
									.filter((item): item is string => Boolean(item)),
								frequency: clean(
									row.querySelector<HTMLElement>('[role="img"]')
										?.getAttribute("aria-label"),
								)?.toLowerCase() ?? "",
							};
						})
						.filter((item) => item !== undefined);
				}
			}

			return {
				fromDidYouMean: clean(didYouMeanBlock?.innerText),
				fromSuggestions,
				fromPronunciation,
				examples,
				definitions: Object.keys(definitions).length > 0
					? definitions
					: undefined,
				translations: Object.keys(translations).length > 0
					? translations
					: undefined,
			};
		},
		from,
		to,
		lite,
		from === "auto",
	);

	return {
		result,
		// fromISO,
		...((fromDidYouMean || fromSuggestions || fromPronunciation) && {
			from: {
				...(fromDidYouMean && { didYouMean: fromDidYouMean }),
				...(fromSuggestions && { suggestions: fromSuggestions }),
				...(fromPronunciation && { pronunciation: fromPronunciation }),
			},
		}),
		...(pronunciation && { pronunciation }),
		examples,
		definitions,
		translations,
	};
};
