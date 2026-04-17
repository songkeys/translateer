import type { Page } from "./browser_session.ts";
import { browserSession } from "./browser_session.ts";
import {
	buildRpcRequest,
	type BuiltRpcRequest,
	ensureGoogleRpcTemplates,
	executeGoogleRpc,
	extractAudioBase64FromBody,
	extractRpcPayload,
	getGoogleRpcTemplates,
	type GoogleRpcTemplateCache,
} from "./google_rpc.ts";

type IExamples = string[];

type IDictionary = {
	headword?: string;
	pronunciation?: string;
	audio?: string;
	examples?: IExamples;
	definitions?: IDefinitions;
	synonyms?: ISynonyms;
	related?: IRelated;
	translations?: ITranslations;
};

type ISide = {
	detectedLanguage?: string;
	didYouMean?: string;
	suggestions?: IFromSuggestions;
	pronunciation?: string;
	audio?: string;
	dictionary?: IDictionary;
};

type IAudio = {
	from?: string;
	fromDictionary?: string;
	to?: string;
	toDictionary?: string;
};

type IFromSuggestions = {
	text: string;
	translation: string;
}[];

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

type ISynonyms = Record<
	string,
	{
		labels?: string[];
		words: string[];
	}[]
>;

type IRelated = string[];

type TranslationResult = {
	result: string;
	resolvedFrom: string;
	detectedLanguage?: string;
	didYouMean?: string;
	sourcePronunciation?: string;
	targetPronunciation?: string;
};

type CardResult = {
	headword?: string;
	pronunciation?: string;
	examples?: IExamples;
	definitions?: IDefinitions;
	synonyms?: ISynonyms;
	related?: IRelated;
	translations?: ITranslations;
};

const PART_OF_SPEECH_LABELS: Record<number, string> = {
	1: "noun",
	2: "verb",
	3: "adjective",
	4: "adverb",
	5: "preposition",
	6: "abbreviation",
	7: "conjunction",
	8: "pronoun",
	9: "interjection",
	10: "phrase",
	11: "prefix",
	12: "suffix",
	13: "article",
	14: "combining_form",
	15: "numeral",
	16: "auxiliary_verb",
	17: "exclamation",
	18: "plural",
	19: "particle",
};

const FREQUENCY_LABELS: Record<number, string> = {
	1: "common",
	2: "uncommon",
	3: "rare",
};

const SAFE_RPC_CHUNK_LIMIT = 800;
const CHUNK_SPLIT_MIN_RATIO = 0.6;

export const parsePage = async (
	page: Page,
	{
		text,
		from,
		to,
		audio,
	}: {
		text: string;
		from: string;
		to: string;
		audio: boolean;
	},
) => {
	await ensureGoogleRpcTemplates(page);
	if (text.length > SAFE_RPC_CHUNK_LIMIT) {
		return await parseLongTextViaGoogleRpc(page, {
			text,
			from,
			to,
			audio,
		});
	}

	return await parseViaGoogleRpc(page, {
		text,
		from,
		to,
		audio,
	}, true);
};

const translateViaGoogleRpc = async (
	page: Page,
	options: {
		text: string;
		from: string;
		to: string;
	},
	allowReinitialize: boolean,
) => {
	const templates = getGoogleRpcTemplates();

	try {
		const translationRequest = buildTranslationRequest(
			templates,
			options.text,
			options.from,
			options.to,
		);
		const translationResponses = await executeGoogleRpc(page, [
			translationRequest,
		]);
		const translationPayload = extractRpcPayload(
			translationResponses.translate.body,
			templates.ids.translate,
		);

		return parseTranslationPayload(
			translationPayload,
			options.text,
			options.from,
		);
	} catch (error) {
		if (!allowReinitialize) {
			throw error;
		}

		await browserSession.withIsolatedPage(async (isolatedPage) => {
			await ensureGoogleRpcTemplates(isolatedPage, {
				force: true,
				validate: true,
			});
		});
		return await translateViaGoogleRpc(page, options, false);
	}
};

const parseViaGoogleRpc = async (
	page: Page,
	options: {
		text: string;
		from: string;
		to: string;
		audio: boolean;
	},
	allowReinitialize: boolean,
) => {
	const templates = getGoogleRpcTemplates();

	try {
		const translation = await translateViaGoogleRpc(
			page,
			{
				text: options.text,
				from: options.from,
				to: options.to,
			},
			false,
		);
		const requests: BuiltRpcRequest[] = [];
		const shouldFetchSuggestions = options.from !== "auto" &&
			Boolean(templates.templates.autocomplete && templates.ids.autocomplete);
		if (shouldFetchSuggestions) {
			requests.push(
				buildAutocompleteRequest(
					templates,
					options.text,
					options.from,
					options.to,
				),
			);
		}

		const translationResponses = shouldFetchSuggestions
			? await executeGoogleRpc(page, requests)
			: undefined;
		const suggestions = shouldFetchSuggestions && templates.ids.autocomplete
			? tryParseAutocompletePayload(
				translationResponses?.autocomplete?.body,
				templates.ids.autocomplete,
			)
			: undefined;

		if (!translation.result) {
			throw new Error("missing translated text from Google RPC response");
		}

		const sourceCardsRequest = buildSourceCardsRequest(
			templates,
			options.text,
			translation.resolvedFrom,
			options.to,
		);
		const targetCardsRequest = buildTargetCardsRequest(
			templates,
			translation.result,
			options.to,
			translation.resolvedFrom,
		);
		const cardResponses = await executeGoogleRpc(page, [
			...(sourceCardsRequest ? [sourceCardsRequest] : []),
			targetCardsRequest,
		]);
		const sourceCards = parseCardsPayload(
			extractRpcPayload(cardResponses.sourceCards.body, templates.ids.cards),
		);
		const targetCards = parseCardsPayload(
			extractRpcPayload(cardResponses.targetCards.body, templates.ids.cards),
		);

		let audioData: IAudio | undefined;
		if (options.audio) {
			audioData = await fetchAudioData(
				page,
				templates,
				options.text,
				translation.result,
				sourceCards?.headword,
				targetCards.headword,
				translation.resolvedFrom,
				options.to,
			);
		}

		const fromSide = compactObject<ISide>({
			...(translation.detectedLanguage && {
				detectedLanguage: translation.detectedLanguage,
			}),
			...(translation.didYouMean && { didYouMean: translation.didYouMean }),
			...(suggestions && { suggestions }),
			...(translation.sourcePronunciation && {
				pronunciation: translation.sourcePronunciation,
			}),
			...(audioData?.from && { audio: audioData.from }),
			dictionary: toDictionaryPayload(sourceCards, audioData?.fromDictionary),
		});
		const toSide = compactObject<ISide>({
			...(translation.targetPronunciation && {
				pronunciation: translation.targetPronunciation,
			}),
			...(audioData?.to && { audio: audioData.to }),
			dictionary: toDictionaryPayload(targetCards, audioData?.toDictionary),
		});

		return compactObject({
			result: translation.result,
			...(hasEntries(fromSide) && { from: fromSide }),
			...(hasEntries(toSide) && { to: toSide }),
		});
	} catch (error) {
		if (!allowReinitialize) {
			throw error;
		}

		await browserSession.withIsolatedPage(async (isolatedPage) => {
			await ensureGoogleRpcTemplates(isolatedPage, {
				force: true,
				validate: true,
			});
		});
		return await parseViaGoogleRpc(page, options, false);
	}
};

const parseLongTextViaGoogleRpc = async (
	page: Page,
	options: {
		text: string;
		from: string;
		to: string;
		audio: boolean;
	},
) => {
	const chunks = splitLongText(options.text);
	const results: { result: string; from?: ISide }[] = [];

	for (const chunk of chunks) {
		const translation = await translateViaGoogleRpc(page, {
			text: chunk.text,
			from: options.from,
			to: options.to,
		}, true);
		if (!translation?.result) {
			throw new Error("missing translated text for chunked translation");
		}

		results.push({
			result: translation.result,
			...((translation.detectedLanguage)
				? {
					from: {
						detectedLanguage: translation.detectedLanguage,
					},
				}
				: {}),
		});
	}

	const combinedResult = results.map((result, index) =>
		result.result + (chunks[index]?.separator ?? "")
	).join("");
	const detectedLanguages = Array.from(
		new Set(
			results
				.map((result) => result.from?.detectedLanguage)
				.filter((language): language is string => Boolean(language)),
		),
	);
	const fromSide = compactObject<ISide>({
		...(detectedLanguages.length === 1 && {
			detectedLanguage: detectedLanguages[0],
		}),
	});

	return compactObject({
		result: combinedResult,
		...(hasEntries(fromSide) && { from: fromSide }),
	});
};

const tryParseAutocompletePayload = (
	body: string | undefined,
	rpcId: string,
) => {
	if (!body) {
		return undefined;
	}

	try {
		return parseAutocompletePayload(extractRpcPayload(body, rpcId));
	} catch {
		return undefined;
	}
};

const splitLongText = (text: string) => {
	if (text.length <= SAFE_RPC_CHUNK_LIMIT) {
		return [{ text, separator: "" }];
	}

	const chunks: { text: string; separator: string }[] = [];
	let start = 0;

	while (start < text.length) {
		let end = Math.min(start + SAFE_RPC_CHUNK_LIMIT, text.length);
		if (end >= text.length) {
			chunks.push({
				text: text.slice(start),
				separator: "",
			});
			break;
		}

		const split = findChunkBoundary(text, start, end);
		const separatorEnd = advanceSeparator(text, split);
		const chunkText = text.slice(start, split);
		const separator = text.slice(split, separatorEnd);

		chunks.push({
			text: chunkText,
			separator,
		});
		start = separatorEnd;
	}

	return chunks.filter((chunk) => chunk.text.length > 0);
};

const findChunkBoundary = (text: string, start: number, end: number) => {
	const min = Math.max(
		start + Math.floor(SAFE_RPC_CHUNK_LIMIT * CHUNK_SPLIT_MIN_RATIO),
		start + 1,
	);
	const paragraphBreak = text.lastIndexOf("\n\n", end - 1);
	if (paragraphBreak >= min) {
		return paragraphBreak;
	}

	const lineBreak = text.lastIndexOf("\n", end - 1);
	if (lineBreak >= min) {
		return lineBreak;
	}

	for (let index = end - 1; index >= min; index--) {
		if (!/\s/.test(text[index])) {
			continue;
		}

		const previous = text[index - 1];
		if (previous && /[.!?;:。！？]/.test(previous)) {
			return index;
		}
	}

	for (let index = end - 1; index >= min; index--) {
		if (/\s/.test(text[index])) {
			return index;
		}
	}

	return end;
};

const advanceSeparator = (text: string, index: number) => {
	let next = index;
	while (next < text.length && /\s/.test(text[next])) {
		next += 1;
	}

	return next;
};

const buildTranslationRequest = (
	templates: GoogleRpcTemplateCache,
	text: string,
	from: string,
	to: string,
) =>
	buildRpcRequest(templates.templates.translate, (payload) => {
		const next = cloneJson(payload);
		if (!Array.isArray(next) || !Array.isArray(next[0])) {
			throw new Error("unexpected translation payload template");
		}

		next[0][0] = text;
		next[0][1] = from;
		next[0][2] = to;
		return next;
	});

const buildTargetCardsRequest = (
	templates: GoogleRpcTemplateCache,
	text: string,
	from: string,
	to: string,
) =>
	buildRpcRequest(templates.templates.targetCards, (payload) => {
		const next = cloneJson(payload);
		if (!Array.isArray(next) || !Array.isArray(next[0])) {
			throw new Error("unexpected target cards payload template");
		}

		next[0][0] = text;
		next[0][1] = from;
		next[0][2] = to;
		next[1] = 2;
		return next;
	});

const buildSourceCardsRequest = (
	templates: GoogleRpcTemplateCache,
	text: string,
	from: string,
	to: string,
) => {
	const request = buildRpcRequest(
		templates.templates.targetCards,
		(payload) => {
			const next = cloneJson(payload);
			if (!Array.isArray(next) || !Array.isArray(next[0])) {
				throw new Error("unexpected source cards payload template");
			}

			next[0][0] = text;
			next[0][1] = from;
			next[0][2] = to;
			next[1] = 1;
			return next;
		},
	);
	request.responseKey = "sourceCards";
	return request;
};

const buildAudioRequest = (
	templates: GoogleRpcTemplateCache,
	text: string,
	lang: string,
) =>
	buildRpcRequest(templates.templates.audio, (payload) => {
		const next = cloneJson(payload);
		if (!Array.isArray(next)) {
			throw new Error("unexpected audio payload template");
		}

		next[0] = text;
		next[1] = lang;
		return next;
	});

const buildAutocompleteRequest = (
	templates: GoogleRpcTemplateCache,
	text: string,
	from: string,
	to: string,
) => {
	const template = templates.templates.autocomplete;
	if (!template) {
		throw new Error("autocomplete template is not initialized");
	}

	return buildRpcRequest(template, (payload) => {
		const next = cloneJson(payload);
		if (!Array.isArray(next)) {
			throw new Error("unexpected autocomplete payload template");
		}

		next[0] = text;
		next[1] = from;
		next[2] = to;
		return next;
	});
};

const fetchAudioData = async (
	page: Page,
	templates: GoogleRpcTemplateCache,
	sourceText: string,
	translatedText: string,
	sourceDictionaryHeadword: string | undefined,
	targetDictionaryHeadword: string | undefined,
	sourceLang: string,
	targetLang: string,
) => {
	const requests: BuiltRpcRequest[] = [
		{
			...buildAudioRequest(templates, sourceText, sourceLang),
			responseKey: "fromAudio",
		},
		{
			...buildAudioRequest(templates, translatedText, targetLang),
			responseKey: "toAudio",
		},
	];

	const normalizedSourceText = sourceText.trim();
	const normalizedTranslatedText = translatedText.trim();
	const normalizedSourceHeadword = sourceDictionaryHeadword?.trim();
	const normalizedTargetHeadword = targetDictionaryHeadword?.trim();
	const needsSourceDictionaryAudio = normalizedSourceHeadword &&
		normalizedSourceHeadword !== normalizedSourceText;
	const needsTargetDictionaryAudio = normalizedTargetHeadword &&
		normalizedTargetHeadword !== normalizedTranslatedText;
	if (needsSourceDictionaryAudio) {
		requests.push({
			...buildAudioRequest(templates, normalizedSourceHeadword, sourceLang),
			responseKey: "fromDictionaryAudio",
		});
	}
	if (needsTargetDictionaryAudio) {
		requests.push({
			...buildAudioRequest(templates, normalizedTargetHeadword, targetLang),
			responseKey: "toDictionaryAudio",
		});
	}

	const responses = await executeGoogleRpc(page, requests);
	const fromAudio = extractAudioBase64FromBody(responses.fromAudio.body);
	const toAudio = extractAudioBase64FromBody(responses.toAudio.body);
	const fromDictionaryAudio = normalizedSourceHeadword
		? needsSourceDictionaryAudio
			? extractAudioBase64FromBody(responses.fromDictionaryAudio.body)
			: fromAudio
		: undefined;
	const toDictionaryAudio = normalizedTargetHeadword
		? needsTargetDictionaryAudio
			? extractAudioBase64FromBody(responses.toDictionaryAudio.body)
			: toAudio
		: undefined;

	return {
		...(fromAudio && { from: toAudioDataUrl(fromAudio) }),
		...(fromDictionaryAudio && {
			fromDictionary: toAudioDataUrl(fromDictionaryAudio),
		}),
		...(toAudio && { to: toAudioDataUrl(toAudio) }),
		...(toDictionaryAudio &&
			{ toDictionary: toAudioDataUrl(toDictionaryAudio) }),
	} satisfies IAudio;
};

const toDictionaryPayload = (
	cards: CardResult | undefined,
	audio: string | undefined,
): IDictionary | undefined =>
	compactObject<IDictionary>({
		...(cards?.headword && { headword: cards.headword }),
		...(cards?.pronunciation && { pronunciation: cards.pronunciation }),
		...(audio && { audio }),
		...(cards?.examples && { examples: cards.examples }),
		...(cards?.definitions && { definitions: cards.definitions }),
		...(cards?.synonyms && { synonyms: cards.synonyms }),
		...(cards?.related && { related: cards.related }),
		...(cards?.translations && { translations: cards.translations }),
	});

const compactObject = <T extends Record<string, unknown>>(
	value: T,
): T | undefined => {
	const entries = Object.entries(value).filter(([, item]) =>
		item !== undefined
	);
	return entries.length > 0 ? Object.fromEntries(entries) as T : undefined;
};

const hasEntries = (value: Record<string, unknown> | undefined) =>
	Boolean(value && Object.keys(value).length > 0);

const parseTranslationPayload = (
	payload: unknown,
	sourceText: string,
	requestedFrom: string,
): TranslationResult => {
	if (!Array.isArray(payload)) {
		throw new Error("unexpected translation payload");
	}

	const result = payload[1]?.[0]?.[0]?.[5]?.[0]?.[0];
	if (typeof result !== "string" || result.trim() === "") {
		throw new Error("translation payload does not include text");
	}

	const detectedLanguage =
		requestedFrom === "auto" && typeof payload[2] === "string" &&
			payload[2]
			? payload[2]
			: undefined;
	const resolvedFrom = detectedLanguage ?? requestedFrom;
	const correctionEntry = payload[0]?.[1]?.[0]?.[0];
	const correctedText = cleanText(
		asString(correctionEntry?.[4]) ?? asString(correctionEntry?.[1]),
	);
	const sourcePronunciation = cleanText(
		asString(payload[0]?.[0]) ?? asString(payload[3]?.[6]),
	);
	const targetPronunciation = cleanText(
		asString(payload[1]?.[0]?.[0]?.[1]),
	);
	const didYouMean = correctedText &&
			correctedText.toLowerCase() !== cleanText(sourceText)?.toLowerCase()
		? correctedText
		: undefined;

	return {
		result: cleanText(result) ?? result,
		resolvedFrom,
		...(detectedLanguage && { detectedLanguage }),
		...(didYouMean && { didYouMean }),
		...(sourcePronunciation && { sourcePronunciation }),
		...(targetPronunciation && { targetPronunciation }),
	};
};

const parseAutocompletePayload = (
	payload: unknown,
): IFromSuggestions | undefined => {
	if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
		return undefined;
	}

	const suggestions = payload[0]
		.map((entry) => {
			if (!Array.isArray(entry)) {
				return undefined;
			}

			const text = cleanText(asString(entry[0]));
			if (!text) {
				return undefined;
			}

			return {
				text,
				translation: cleanText(asString(entry[1])) ?? "",
			};
		})
		.filter((entry): entry is IFromSuggestions[number] => Boolean(entry));

	return suggestions.length > 0 ? suggestions : undefined;
};

const parseCardsPayload = (payload: unknown): CardResult => {
	if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
		return {};
	}

	const root = payload[0];
	const headword = cleanText(asString(root[0]));
	const definitions = parseDefinitions(root[1]);
	const examples = parseExamples(root[2]);
	const related = parseRelated(root[3]);
	const synonyms = parseTopLevelSynonyms(root[4]);
	const translations = parseTranslations(root[5]);
	const pronunciation = cleanText(asString(root[6]));

	return {
		...(headword && { headword }),
		...(pronunciation && { pronunciation }),
		...(examples && { examples }),
		...(definitions && { definitions }),
		...(synonyms && { synonyms }),
		...(related && { related }),
		...(translations && { translations }),
	};
};

const parseDefinitions = (section: unknown): IDefinitions | undefined => {
	if (!Array.isArray(section) || !Array.isArray(section[0])) {
		return undefined;
	}

	const definitions: IDefinitions = {};
	for (const group of section[0]) {
		if (!Array.isArray(group) || !Array.isArray(group[1])) {
			continue;
		}

		const partOfSpeech = getPartOfSpeechLabel(group[3]);
		const entries = group[1]
			.map((entry) => parseDefinitionEntry(entry))
			.filter((entry) => entry !== undefined);

		if (entries.length === 0) {
			continue;
		}

		definitions[partOfSpeech] = entries;
	}

	return Object.keys(definitions).length > 0 ? definitions : undefined;
};

const parseDefinitionEntry = (entry: unknown) => {
	if (!Array.isArray(entry)) {
		return undefined;
	}

	const definition = cleanText(asString(entry[0]));
	if (!definition) {
		return undefined;
	}

	const example = cleanText(asString(entry[1]));
	const labels = extractNestedStrings(entry[4]);
	const synonyms = parseSynonymGroups(entry[5]);

	return {
		definition,
		...(example && { example }),
		...(labels.length > 0 && { labels }),
		...(Object.keys(synonyms).length > 0 && { synonyms }),
	};
};

const parseSynonymGroups = (value: unknown) => {
	const groups = Array.isArray(value) ? value : [];
	const synonyms: Record<string, string[]> = {};

	for (const group of groups) {
		if (!Array.isArray(group)) {
			continue;
		}

		const words = extractNestedStrings(group[0]);
		if (words.length === 0) {
			continue;
		}

		const labels = extractNestedStrings(group[1]);
		const key = labels.length > 0 ? labels.join(", ") : "common";
		synonyms[key] = Array.from(new Set(words));
	}

	return synonyms;
};

const parseExamples = (section: unknown): IExamples | undefined => {
	if (!Array.isArray(section) || !Array.isArray(section[0])) {
		return undefined;
	}

	const examples = section[0]
		.map((entry) => {
			if (!Array.isArray(entry)) {
				return undefined;
			}

			return cleanText(asString(entry[1] ?? entry[0]));
		})
		.filter((example): example is string => Boolean(example));

	return examples.length > 0 ? examples : undefined;
};

const parseRelated = (section: unknown): IRelated | undefined => {
	if (!Array.isArray(section)) {
		return undefined;
	}

	const related = Array.from(new Set(extractNestedStrings(section[0])));
	return related.length > 0 ? related : undefined;
};

const parseTopLevelSynonyms = (section: unknown): ISynonyms | undefined => {
	if (!Array.isArray(section) || !Array.isArray(section[0])) {
		return undefined;
	}

	const synonyms: ISynonyms = {};
	for (const group of section[0]) {
		if (!Array.isArray(group) || !Array.isArray(group[1])) {
			continue;
		}

		const partOfSpeech = getPartOfSpeechLabel(group[3]);
		const labels = extractNestedStrings(group[2]);
		const entries = group[1]
			.map((entry) => {
				const words = Array.from(new Set(extractNestedStrings(entry)));
				if (words.length === 0) {
					return undefined;
				}

				return {
					...(labels.length > 0 && { labels }),
					words,
				};
			})
			.filter((entry) => entry !== undefined);

		if (entries.length === 0) {
			continue;
		}

		synonyms[partOfSpeech] = entries;
	}

	return Object.keys(synonyms).length > 0 ? synonyms : undefined;
};

const parseTranslations = (section: unknown): ITranslations | undefined => {
	if (!Array.isArray(section) || !Array.isArray(section[0])) {
		return undefined;
	}

	const translations: ITranslations = {};
	for (const group of section[0]) {
		if (!Array.isArray(group) || !Array.isArray(group[1])) {
			continue;
		}

		const entries = group[1];
		const partOfSpeech = getPartOfSpeechLabel(group[4]);
		const parsedEntries = entries
			.map((entry) => parseTranslationEntry(entry))
			.filter((entry) => entry !== undefined);

		if (parsedEntries.length === 0) {
			continue;
		}

		translations[partOfSpeech] = parsedEntries;
	}

	return Object.keys(translations).length > 0 ? translations : undefined;
};

const parseTranslationEntry = (entry: unknown) => {
	if (!Array.isArray(entry)) {
		return undefined;
	}

	const translation = cleanText(asString(entry[0]));
	if (!translation) {
		return undefined;
	}

	return {
		translation,
		reversedTranslations: extractNestedStrings(entry[2]),
		frequency: getFrequencyLabel(entry[3]),
	};
};

const getPartOfSpeechLabel = (value: unknown) => {
	const numeric = typeof value === "number" ? value : undefined;
	if (!numeric) {
		return "unknown";
	}

	return PART_OF_SPEECH_LABELS[numeric] ?? `part_of_speech_${numeric}`;
};

const getFrequencyLabel = (value: unknown) => {
	const numeric = typeof value === "number" ? value : undefined;
	if (!numeric) {
		return "";
	}

	return FREQUENCY_LABELS[numeric] ?? `tier_${numeric}`;
};

const extractNestedStrings = (value: unknown): string[] => {
	if (typeof value === "string") {
		const cleaned = cleanText(value);
		return cleaned ? [cleaned] : [];
	}

	if (!Array.isArray(value)) {
		return [];
	}

	return value.flatMap((item) => extractNestedStrings(item));
};

const asString = (value: unknown) =>
	typeof value === "string" ? value : undefined;

const cleanText = (value?: string | null) => {
	if (!value) {
		return undefined;
	}

	const decoded = decodeHtml(stripHtml(value));
	return decoded
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\s+/g, " ")
		.trim() || undefined;
};

const stripHtml = (value: string) => value.replace(/<[^>]+>/g, "");

const decodeHtml = (value: string) =>
	value
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");

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

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));
