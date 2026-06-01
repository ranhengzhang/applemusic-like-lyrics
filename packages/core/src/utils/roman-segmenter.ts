/**
 * Roman 音译分段工具
 * 用于将 roman 字符串按照 ruby 假名进行分段
 */

import type { LyricWordBase } from "../interfaces.ts";

// 平假名 Unicode 范围
const HIRAGANA_START = 0x3040;
const HIRAGANA_END = 0x309f;

// 片假名 Unicode 范围
const KATAKANA_START = 0x30a0;
const KATAKANA_END = 0x30ff;

// 特殊假名：んっンッ
const SPECIAL_KANA = new Set(["ん", "っ", "ン", "ッ"]);

// 小写假名（需要跳过）
const SMALL_KANA = new Set([
	"ぁ",
	"ぃ",
	"ぅ",
	"ぇ",
	"ぉ",
	"ゃ",
	"ゅ",
	"ょ",
	"ァ",
	"ィ",
	"ゥ",
	"ェ",
	"ォ",
	"ャ",
	"ュ",
	"ョ",
]);

// 元音字符
const VOWELS = new Set(["a", "e", "i", "o", "u", "A", "E", "I", "O", "U"]);

/**
 * 判断字符是否是平假名
 */
function isHiragana(char: string): boolean {
	const code = char.charCodeAt(0);
	return code >= HIRAGANA_START && code <= HIRAGANA_END;
}

/**
 * 判断字符是否是片假名
 */
function isKatakana(char: string): boolean {
	const code = char.charCodeAt(0);
	return code >= KATAKANA_START && code <= KATAKANA_END;
}

/**
 * 判断字符是否是假名（平假名或片假名）
 */
function isKana(char: string): boolean {
	return isHiragana(char) || isKatakana(char);
}

/**
 * 判断字符是否是元音
 */
function isVowel(char: string): boolean {
	return VOWELS.has(char);
}

/**
 * 判断字符是否是空格
 */
function isSpace(char: string): boolean {
	return char === " " || char === "\t";
}

/**
 * 获取下一个有效字符（跳过空格）
 * @param str 字符串
 * @param index 起始索引
 * @returns [字符, 新索引] 或 [null, -1] 如果没有更多字符
 */
function getNextChar(str: string, index: number): [string, number] | null {
	for (let i = index; i < str.length; i++) {
		const char = str[i];
		if (!isSpace(char)) {
			return [char, i];
		}
	}
	return null;
}

/**
 * 获取下一个罗马音
 * @param roman 罗马音字符串
 * @param ruby ruby 字符串
 * @returns [下一个罗马音, 剪除后的 ruby 字符串] 或 null 如果无法匹配
 */
export function getNextRomaji(
	roman: string,
	ruby: string,
): { romaji: string; remainingRuby: string } | null {
	let romanIndex = 0;
	let rubyIndex = 0;

	// 跳过 roman 开头的空格，但要记录以便保留
	let leadingSpaces = "";
	while (romanIndex < roman.length && isSpace(roman[romanIndex])) {
		leadingSpaces += roman[romanIndex];
		romanIndex++;
	}

	// 跳过 ruby 开头的空格
	while (rubyIndex < ruby.length && isSpace(ruby[rubyIndex])) {
		rubyIndex++;
	}

	// 如果 ruby 已经空了，返回 null
	if (rubyIndex >= ruby.length) {
		return null;
	}

	// 遍历 ruby 字符
	while (rubyIndex < ruby.length) {
		const rubyChar = ruby[rubyIndex];

		// 跳过 ruby 中的空格
		if (isSpace(rubyChar)) {
			rubyIndex++;
			continue;
		}

		// 如果不是假名，跳过
		if (!isKana(rubyChar)) {
			rubyIndex++;
			continue;
		}

		// 判断是否是特殊假名（んっンッ）
		if (SPECIAL_KANA.has(rubyChar)) {
			// 向后获取一个有效字符
			const nextResult = getNextChar(ruby, rubyIndex + 1);
			if (nextResult) {
				// 对于特殊假名，我们需要从 roman 中消耗对应的字符
				// ん/ン 通常对应 'n'，っ/ッ 通常双写下一个辅音
				// 这里简化处理：消耗 roman 中直到遇到元音或空格的所有字符
				let romajiPart = "";
				while (romanIndex < roman.length) {
					const rChar = roman[romanIndex];
					if (isSpace(rChar)) break;
					romajiPart += rChar;
					romanIndex++;
					if (isVowel(rChar)) break;
				}

				// 如果是 っ/ッ，可能还需要消耗一个字符
				if (
					(rubyChar === "っ" || rubyChar === "ッ") &&
					romanIndex < roman.length
				) {
					const nextR = roman[romanIndex];
					if (!isSpace(nextR) && !isVowel(nextR)) {
						romajiPart += nextR;
						romanIndex++;
					}
				}

				rubyIndex = nextResult[1] + 1;
				const remainingRuby = ruby.slice(rubyIndex);
				return {
					romaji: leadingSpaces + romajiPart,
					remainingRuby,
				};
			}
			// 如果没有更多字符，只消耗当前特殊假名对应的 roman
			let romajiPart = "";
			while (romanIndex < roman.length) {
				const rChar = roman[romanIndex];
				if (isSpace(rChar)) break;
				romajiPart += rChar;
				romanIndex++;
				if (isVowel(rChar)) break;
			}
			rubyIndex++;
			const remainingRuby = ruby.slice(rubyIndex);
			return {
				romaji: leadingSpaces + romajiPart,
				remainingRuby,
			};
		}

		// 判断是否是小写假名（需要跳过）
		if (SMALL_KANA.has(rubyChar)) {
			rubyIndex++;
			continue;
		}

		// 普通假名：向后获取直到一个元音字符
		let romajiPart = "";
		while (romanIndex < roman.length) {
			const rChar = roman[romanIndex];
			if (isSpace(rChar)) break;
			romajiPart += rChar;
			romanIndex++;
			if (isVowel(rChar)) break;
		}

		rubyIndex++;
		const remainingRuby = ruby.slice(rubyIndex);
		return {
			romaji: leadingSpaces + romajiPart,
			remainingRuby,
		};
	}

	// 如果遍历完 ruby 但没有找到有效假名
	return null;
}

/**
 * 判断 ruby 数组是否全是假名
 */
function isAllKana(rubySegments: LyricWordBase[]): boolean {
	for (const segment of rubySegments) {
		for (const char of segment.word) {
			if (!isSpace(char) && !isKana(char)) {
				return false;
			}
		}
	}
	return true;
}

/**
 * Roman 分段结果
 */
export interface RomanSegment {
	romaji: string;
	startTime: number;
	endTime: number;
	isSpace: boolean; // 标记是否是纯空格段
}

/**
 * 将 roman 字符串按照 ruby 分段
 * @param roman 完整的 roman 字符串
 * @param rubySegments ruby 分段数组
 * @returns 分段结果数组，如果无法分段则返回 null
 */
export function segmentRomanByRuby(
	roman: string,
	rubySegments: LyricWordBase[],
): RomanSegment[] | null {
	if (!roman || rubySegments.length === 0) {
		return null;
	}

	const trimmedRoman = roman.trim();
	if (trimmedRoman.length === 0) {
		return null;
	}

	// 检查是否全是假名
	const allKana = isAllKana(rubySegments);

	if (allKana) {
		// 方案 1：使用「获取下一个罗马音」函数
		const segments: RomanSegment[] = [];
		let remainingRoman = roman;

		for (const rubySeg of rubySegments) {
			const rubyText = rubySeg.word;
			const result = getNextRomaji(remainingRoman, rubyText);

			if (result === null) {
				// 无法匹配，回退到不分割方案
				return null;
			}

			segments.push({
				romaji: result.romaji,
				startTime: rubySeg.startTime,
				endTime: rubySeg.endTime,
				isSpace: result.romaji.trim().length === 0,
			});

			remainingRoman = roman.slice(
				roman.indexOf(result.romaji) + result.romaji.length,
			);
		}

		// 检查最后一次返回的剪除后的 ruby 字符串 trim 后是否为空
		// 实际上我们需要检查 remainingRoman 是否只包含空格
		if (remainingRoman.trim().length > 0) {
			// 还有剩余的 roman，回退到不分割方案
			return null;
		}

		return segments;
	}

	// 方案 2：按空格分割
	const romanParts = trimmedRoman.split(/\s+/).filter((p) => p.length > 0);

	// 判断数量是否一致
	if (romanParts.length !== rubySegments.length) {
		return null;
	}

	// 按照空格分隔分组设置分段
	const segments: RomanSegment[] = [];
	let romanIndex = 0;

	for (let i = 0; i < rubySegments.length; i++) {
		const rubySeg = rubySegments[i];
		const part = romanParts[i];

		// 处理前导空格
		let leadingSpaces = "";
		while (romanIndex < roman.length && isSpace(roman[romanIndex])) {
			leadingSpaces += roman[romanIndex];
			romanIndex++;
		}

		// 添加分段
		segments.push({
			romaji: leadingSpaces + part,
			startTime: rubySeg.startTime,
			endTime: rubySeg.endTime,
			isSpace: false,
		});

		// 跳过当前 part
		romanIndex += part.length;
	}

	return segments;
}

/**
 * Roman 分段项，可能是一个分段或一个空格字符串
 */
export type RomanSegmentItem =
	| { type: "segment"; segment: RomanSegment }
	| { type: "space"; content: string };

/**
 * 处理分段后的空格分离
 * 将 span 首尾的空格分离出来，作为独立的空格项
 * 例如：["ki t", "ta", " i"] -> ["ki t", "ta", " ", "i"]
 * @param segments 分段结果
 * @returns 处理后的分段项数组（包含分段和空格）
 */
export function normalizeSpaces(segments: RomanSegment[]): RomanSegmentItem[] {
	if (segments.length === 0) return [];

	const result: RomanSegmentItem[] = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		let romaji = seg.romaji;

		// 分离头部空格
		let leadingSpaces = "";
		while (romaji.startsWith(" ")) {
			leadingSpaces += " ";
			romaji = romaji.slice(1);
		}

		// 分离尾部空格
		let trailingSpaces = "";
		while (romaji.endsWith(" ")) {
			trailingSpaces += " ";
			romaji = romaji.slice(0, -1);
		}

		// 添加头部空格（如果不是第一个分段，则前导空格已经在前一个分段的尾部处理过了）
		// 实际上，我们只在当前分段有内容时才添加前导空格
		if (leadingSpaces && result.length > 0) {
			result.push({ type: "space", content: leadingSpaces });
		}

		// 添加分段内容（如果有）
		if (romaji.length > 0) {
			result.push({
				type: "segment",
				segment: {
					...seg,
					romaji: romaji,
					isSpace: false,
				},
			});
		}

		// 添加尾部空格（如果不是最后一个分段，则作为独立项）
		if (trailingSpaces && i < segments.length - 1) {
			result.push({ type: "space", content: trailingSpaces });
		}
	}

	return result;
}
