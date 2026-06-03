import type { LyricWord } from "../interfaces.ts";
import { isCJK } from "./is-cjk.ts";

const hasSegmenter =
	typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined";

/**
 * 将输入的单词重新分组，之间没有空格的单词将会组合成一个单词数组
 *
 * 例如输入：`["Life", " ", "is", " a", " su", "gar so", "sweet"]`
 *
 * 应该返回：`["Life", " ", "is", " a", [" su", "gar"], "so", "sweet"]`
 * @param words 输入的单词数组
 * @returns 重新分组后的单词数组
 */
export function chunkAndSplitLyricWords(
	words: LyricWord[],
): (LyricWord | LyricWord[])[] {
	const atoms: LyricWord[] = [];

	for (const w of words) {
		const content = w.word.trim();
		const isSpace = content.length === 0;
		const romanWord = w.romanWord ?? "";
		const obscene = w.obscene ?? false;
		const hasRuby = (w.ruby?.length ?? 0) > 0;

		if (isSpace) {
			atoms.push({ ...w });
			continue;
		}
		if (hasRuby) {
			atoms.push({ ...w });
			continue;
		}

		const parts = w.word.split(/(\s+)/).filter((p) => p.length > 0);

		let currentOffset = 0;
		const totalLength = w.word.replace(/\s/g, "").length || 1;

		for (const part of parts) {
			if (!part.trim()) {
				const startTime =
					w.startTime +
					(currentOffset / totalLength) * (w.endTime - w.startTime);

				atoms.push({
					word: part,
					romanWord: "",
					startTime: startTime,
					endTime: startTime,
					obscene: obscene,
				});
				continue;
			}

			if (isCJK(part) && part.length > 1 && romanWord.trim().length === 0) {
				// CJK 文本不再拆分成单个字符
				// 而是作为一个整体处理，让 Intl.Segmenter 或后续逻辑按语义分组
				const partRealLen = part.length;
				const duration =
					(partRealLen / totalLength) * (w.endTime - w.startTime);
				const startTime =
					w.startTime +
					(currentOffset / totalLength) * (w.endTime - w.startTime);

				atoms.push({
					word: part,
					romanWord: "",
					startTime: startTime,
					endTime: startTime + duration,
					obscene: obscene,
				});
				currentOffset += partRealLen;
			} else {
				const partRealLen = part.length;
				const duration =
					(partRealLen / totalLength) * (w.endTime - w.startTime);
				const startTime =
					w.startTime +
					(currentOffset / totalLength) * (w.endTime - w.startTime);

				atoms.push({
					word: part,
					romanWord: romanWord,
					startTime: startTime,
					endTime: startTime + duration,
					obscene: obscene,
				});
				currentOffset += partRealLen;
			}
		}
	}

	// 对于 CJK 文本，按空格分组，而不是按语义分组
	// 连续的 CJK 文本（没有空格）应该合并为一个组
	const result: (LyricWord | LyricWord[])[] = [];
	let currentGroup: LyricWord[] = [];

	for (let i = 0; i < atoms.length; i++) {
		const atom = atoms[i];
		const isSpace = !atom.word.trim();

		if (isSpace) {
			// 遇到空格，先结束当前组
			if (currentGroup.length === 1) {
				result.push(currentGroup[0]);
			} else if (currentGroup.length > 1) {
				result.push(currentGroup);
			}
			currentGroup = [];
			// 添加空格
			result.push(atom);
		} else {
			// 非空格，添加到当前组
			currentGroup.push(atom);
		}
	}

	// 处理最后一组
	if (currentGroup.length === 1) {
		result.push(currentGroup[0]);
	} else if (currentGroup.length > 1) {
		result.push(currentGroup);
	}

	return result;
}
