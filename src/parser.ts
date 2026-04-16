import type { Page } from "./pagepool.ts";

type IExamples = string[];

type IAudio = {
	source?: string;
	translation?: string;
	dictionary?: string;
};

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

const GOOGLE_BATCHEXECUTE_URL =
	"https://translate.google.com/_/TranslateWebserverUi/data/batchexecute";
const AUDIO_RPC_ID = "jQ1olc";

const extractBatchedJsonChunks = (body: string) => {
	const lines = body.split("\n").filter(Boolean);
	const chunks: unknown[] = [];

	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === ")]}'") {
			continue;
		}

		if (/^\d+$/.test(lines[i]) && i + 1 < lines.length) {
			const candidate = lines[i + 1];
			if (candidate.startsWith("[")) {
				try {
					chunks.push(JSON.parse(candidate));
				} catch {
					// Ignore non-JSON chunks in the batchexecute envelope.
				}
			}
			i += 1;
		}
	}

	return chunks;
};

const extractAudioBase64FromBody = (body: string) => {
	const wrbEntry = extractBatchedJsonChunks(body)
		.flatMap((chunk) => Array.isArray(chunk) ? chunk : [])
		.find((entry) =>
			Array.isArray(entry) &&
			entry[0] === "wrb.fr" &&
			entry[1] === AUDIO_RPC_ID &&
			typeof entry[2] === "string"
		);

	if (!wrbEntry || typeof wrbEntry[2] !== "string") {
		return undefined;
	}

	try {
		const payload = JSON.parse(wrbEntry[2]);
		return Array.isArray(payload) && typeof payload[0] === "string"
			? payload[0]
			: undefined;
	} catch {
		return undefined;
	}
};

const detectAudioMimeTypeFromBase64 = (base64: string) => {
	const bytes = Uint8Array.from(
		atob(base64.slice(0, 64)),
		(char) => char.charCodeAt(0),
	);

	if (
		bytes[0] === 0x49 &&
		bytes[1] === 0x44 &&
		bytes[2] === 0x33
	) {
		return "audio/mpeg";
	}

	if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
		return "audio/mpeg";
	}

	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46
	) {
		return "audio/wav";
	}

	if (
		bytes[0] === 0x4f &&
		bytes[1] === 0x67 &&
		bytes[2] === 0x67 &&
		bytes[3] === 0x53
	) {
		return "audio/ogg";
	}

	return "application/octet-stream";
};

const toAudioDataUrl = (base64: string) =>
	`data:${detectAudioMimeTypeFromBase64(base64)};base64,${base64}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const findVisibleButtonIndex = async (
	page: Page,
	selector: string,
	timeout = 5000,
) => {
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		const index = await page.evaluate((selector) => {
			const buttons = Array.from(
				document.querySelectorAll<HTMLElement>(selector),
			);

			return buttons.findIndex((button) => {
				const style = getComputedStyle(button);
				const rect = button.getBoundingClientRect();
				return rect.width > 0 &&
					rect.height > 0 &&
					style.display !== "none" &&
					style.visibility !== "hidden" &&
					!button.hasAttribute("disabled") &&
					button.getAttribute("aria-hidden") !== "true";
			});
		}, selector).catch(() => -1);

		if (index >= 0) {
			return index;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	return undefined;
};

const clickVisibleButton = async (
	page: Page,
	selector: string,
	timeout = 5000,
) => {
	const index = await findVisibleButtonIndex(page, selector, timeout);
	if (index === undefined) {
		return false;
	}

	return await page.evaluate(
		(selector, index) => {
			const button = Array.from(
				document.querySelectorAll<HTMLElement>(selector),
			)[index];
			if (!button) {
				return false;
			}

			button.click();
			return true;
		},
		selector,
		index,
	).catch(() => false);
};

const extractAudioRequestKeyFromPostData = (postData?: string | null) => {
	if (!postData) {
		return undefined;
	}

	try {
		const params = new URLSearchParams(postData);
		const batchPayload = params.get("f.req");
		if (!batchPayload) {
			return undefined;
		}

		const entries = JSON.parse(batchPayload);
		const firstEntry = entries?.[0]?.[0];
		if (
			!Array.isArray(firstEntry) ||
			firstEntry[0] !== AUDIO_RPC_ID ||
			typeof firstEntry[1] !== "string"
		) {
			return undefined;
		}

		return firstEntry[1];
	} catch {
		return undefined;
	}
};

const isAudioRpcRequest = (url: string) => {
	if (!url.startsWith(GOOGLE_BATCHEXECUTE_URL)) {
		return false;
	}

	try {
		return new URL(url).searchParams.get("rpcids") === AUDIO_RPC_ID;
	} catch {
		return false;
	}
};

const captureAudioDataUrls = async (
	page: Page,
	jobs: { role: keyof IAudio; selector: string }[],
) => {
	const visibleJobs = (
		await Promise.all(
			jobs.map(async (job) => ({
				...job,
				hasButton: (await findVisibleButtonIndex(page, job.selector)) !==
					undefined,
			})),
		)
	).filter(
		(job): job is { role: keyof IAudio; selector: string; hasButton: true } =>
			job.hasButton,
	);

	if (visibleJobs.length === 0) {
		return undefined;
	}

	const audioByRequestKey = new Map<string, string>();
	const onResponse = async (response: {
		url(): string;
		request(): { postData(): string | undefined };
		text(): Promise<string>;
	}) => {
		if (!isAudioRpcRequest(response.url())) {
			return;
		}

		const requestKey = extractAudioRequestKeyFromPostData(
			response.request().postData(),
		);
		if (!requestKey || audioByRequestKey.has(requestKey)) {
			return;
		}

		const body = await response.text().catch(() => undefined);
		if (!body) {
			return;
		}

		const audioBase64 = extractAudioBase64FromBody(body);
		if (!audioBase64) {
			return;
		}

		audioByRequestKey.set(requestKey, toAudioDataUrl(audioBase64));
	};

	page.on("response", onResponse);

	try {
		const roleRequests: { role: keyof IAudio; requestKey?: string }[] = [];

		// Capture each outgoing audio request as soon as it is dispatched, then let
		// the corresponding responses resolve in parallel on the shared page.
		for (const job of visibleJobs) {
			const requestPromise = page.waitForRequest((request) => {
				return isAudioRpcRequest(request.url());
			}, { timeout: 5000 }).catch(() => undefined);

			const clicked = await clickVisibleButton(page, job.selector);
			if (!clicked) {
				roleRequests.push({ role: job.role });
				continue;
			}

			const request = await requestPromise;
			roleRequests.push({
				role: job.role,
				requestKey: extractAudioRequestKeyFromPostData(request?.postData()),
			});
		}

		const uniqueKeys = [
			...new Set(
				roleRequests
					.map((job) => job.requestKey)
					.filter((requestKey): requestKey is string => Boolean(requestKey)),
			),
		];
		const deadline = Date.now() + 5000;

		while (
			uniqueKeys.some((requestKey) => !audioByRequestKey.has(requestKey)) &&
			Date.now() < deadline
		) {
			await sleep(50);
		}

		const audio = roleRequests.reduce<IAudio>((result, job) => {
			if (!job.requestKey) {
				return result;
			}

			const dataUrl = audioByRequestKey.get(job.requestKey);
			if (dataUrl) {
				result[job.role] = dataUrl;
			}

			return result;
		}, {});

		return Object.keys(audio).length > 0 ? audio : undefined;
	} finally {
		page.off("response", onResponse);
	}
};

export const parsePage = async (
	page: Page,
	{
		text,
		from,
		to,
		lite,
		audio,
	}: {
		text: string;
		from: string;
		to: string;
		lite: boolean;
		audio: boolean;
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

	const audioData: IAudio | undefined = audio
		? await captureAudioDataUrls(page, [
			{
				role: "source",
				selector: 'button[aria-label="Listen to source text"]',
			},
			{
				role: "translation",
				selector: 'button[aria-label="Listen to translation"]',
			},
			...(!lite
				? [{
					role: "dictionary" as const,
					selector: `c-wiz[role="complementary"] button[aria-label="Listen"]`,
				}]
				: []),
		])
		: undefined;
	const hasAudio = Boolean(
		audioData &&
			(audioData.source || audioData.translation || audioData.dictionary),
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
		...(hasAudio && { audio: audioData }),
		examples,
		definitions,
		translations,
	};
};
