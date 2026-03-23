import bezier from "bezier-easing";
import {
	type LyricLine,
	LyricLineRenderMode,
	type LyricWord,
} from "../../interfaces.ts";
import styles from "../../styles/lyric-player.module.css";
import { isCJK } from "../../utils/is-cjk.ts";
import { chunkAndSplitLyricWords } from "../../utils/lyric-split-words.ts";
import {
	createMatrix4,
	matrix4ToCSS,
	scaleMatrix4,
} from "../../utils/matrix.ts";
import { LyricLineBase } from "../base.ts";
import type { DomLyricPlayer } from ".";

interface RealWord extends LyricWord {
	mainElement: HTMLSpanElement;
	subElements: HTMLSpanElement[];
	elementAnimations: Animation[];
	maskAnimations: Animation[];
	width: number;
	height: number;
	padding: number;
	shouldEmphasize: boolean;
}

const ANIMATION_FRAME_QUANTITY = 32;

const norNum = (min: number, max: number) => (x: number) =>
	Math.min(1, Math.max(0, (x - min) / (max - min)));
const EMP_EASING_MID = 0.5;
const beginNum = norNum(0, EMP_EASING_MID);
const endNum = norNum(EMP_EASING_MID, 1);

const bezIn = bezier(0.2, 0.4, 0.58, 1.0);
const bezOut = bezier(0.3, 0.0, 0.58, 1.0);

const makeEmpEasing = (mid: number) => {
	return (x: number) => (x < mid ? bezIn(beginNum(x)) : 1 - bezOut(endNum(x)));
};

function generateFadeGradient(
	width: number,
	padding = 0,
	bright = "rgba(0,0,0,var(--bright-mask-alpha, 1.0))",
	dark = "rgba(0,0,0,var(--dark-mask-alpha, 1.0))",
): [string, number] {
	const totalAspect = 2 + width + padding;
	const widthInTotal = width / totalAspect;
	const leftPos = (1 - widthInTotal) / 2;
	return [
		`linear-gradient(to right,${bright} ${leftPos * 100}%,${dark} ${
			(leftPos + widthInTotal) * 100
		}%)`,
		totalAspect,
	];
}

export class RawLyricLineMouseEvent extends MouseEvent {
	constructor(
		public readonly line: LyricLineBase,
		event: MouseEvent,
	) {
		super(event.type, event);
	}
}

type MouseEventMap = {
	[evt in keyof HTMLElementEventMap]: HTMLElementEventMap[evt] extends MouseEvent
		? evt
		: never;
};
type MouseEventTypes = MouseEventMap[keyof MouseEventMap];
type MouseEventListener = (
	this: LyricLineEl,
	ev: RawLyricLineMouseEvent,
) => void;

export class LyricLineEl extends LyricLineBase {
	private element: HTMLElement = document.createElement("div");
	private splittedWords: RealWord[] = [];
	// 标记是否已经构建了行内的实际 DOM（单词与动画等）
	private built = false;

	// 由 LyricPlayer 来设置
	lineSize: number[] = [0, 0];

	private renderMode = LyricLineRenderMode.SOLID;

	private currentBrightAlpha = 1.0;
	private currentDarkAlpha = 0.2;

	private targetBrightAlpha = 1.0;
	private targetDarkAlpha = 0.2;

	constructor(
		private lyricPlayer: DomLyricPlayer,
		private lyricLine: LyricLine = {
			words: [],
			translatedLyric: "",
			romanLyric: "",
			startTime: 0,
			endTime: 0,
			isBG: false,
			isDuet: false,
		},
	) {
		super();
		this._prevParentEl = lyricPlayer.getElement();
		lyricPlayer.resizeObserver.observe(this.element);
		this.element.setAttribute("class", styles.lyricLine);
		if (this.lyricLine.isBG) {
			this.element.classList.add(styles.lyricBgLine);
		}
		if (this.lyricLine.isDuet) {
			this.element.classList.add(styles.lyricDuetLine);
		}
		this.lineTransforms.posY.setPosition(window.innerHeight * 2);
		this.element.appendChild(document.createElement("div")); // 歌词行
		this.element.appendChild(document.createElement("div")); // 翻译行
		this.element.appendChild(document.createElement("div")); // 音译行
		const main = this.element.children[0] as HTMLDivElement;
		const trans = this.element.children[1] as HTMLDivElement;
		const roman = this.element.children[2] as HTMLDivElement;
		main.setAttribute("class", styles.lyricMainLine);
		trans.setAttribute("class", `${styles.lyricSubLine} ${styles.lyricTransLine}`);
		roman.setAttribute("class", `${styles.lyricSubLine} ${styles.lyricRomanLine}`);
		// 延迟构建具体行内容，进入可视区（含 overscan）时再构建
		this.rebuildStyle();
	}
	private listenersMap = new Map<string, Set<MouseEventListener>>();
	private readonly onMouseEvent = (e: MouseEvent) => {
		const wrapped = new RawLyricLineMouseEvent(this, e);
		for (const listener of this.listenersMap.get(e.type) ?? []) {
			listener.call(this, wrapped);
		}
		if (!this.dispatchEvent(wrapped) || wrapped.defaultPrevented) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
			return false;
		}
	};

	addMouseEventListener(
		type: MouseEventTypes,
		callback: MouseEventListener | null,
		options?: boolean | AddEventListenerOptions | undefined,
	): void {
		if (callback) {
			const listeners = this.listenersMap.get(type) ?? new Set();
			if (listeners.size === 0)
				this.element.addEventListener(type, this.onMouseEvent, options);
			listeners.add(callback);
			this.listenersMap.set(type, listeners);
		}
	}

	removeMouseEventListener(
		type: MouseEventTypes,
		callback: MouseEventListener | null,
		options?: boolean | EventListenerOptions | undefined,
	): void {
		if (callback) {
			const listeners = this.listenersMap.get(type);
			if (listeners) {
				listeners.delete(callback);
				if (listeners.size === 0)
					this.element.removeEventListener(type, this.onMouseEvent, options);
			}
		}
	}

	areWordsOnSameLine(word1: RealWord, word2: RealWord) {
		if (word1?.mainElement && word2?.mainElement) {
			const word1el = word1.mainElement;
			const word2el = word2.mainElement;

			const rect1 = word1el.getBoundingClientRect();
			const rect2 = word2el.getBoundingClientRect();

			// 检查两个单词的顶部距离是否相等（或者差值很小）
			const topDifference = Math.abs(rect1.top - rect2.top);

			// 如果顶部距离相差很小，可以认为它们在同一行上
			return topDifference < 10;
		}

		return true;
	}

	private isEnabled = false;
	async enable(
		maskAnimationTime = this.lyricLine.startTime,
		shouldPlay = true,
	) {
		this.isEnabled = true;
		this.element.classList.add(styles.active);
		const main = this.element.children[0] as HTMLDivElement;

		const relativeTime = Math.max(
			0,
			maskAnimationTime - this.lyricLine.startTime,
		);
		const actualMaskTime =
			maskAnimationTime === this.lyricLine.startTime
				? this.lyricPlayer.getCurrentTime()
				: maskAnimationTime;

		const maskRelativeTime = Math.max(
			0,
			actualMaskTime - this.lyricLine.startTime,
		);

		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				a.currentTime = relativeTime;
				a.playbackRate = 1;

				const timing = a.effect?.getComputedTiming();
				const duration = (timing?.duration as number) || 0;
				const delay = (timing?.delay as number) || 0;
				const endTime = delay + duration;

				if (shouldPlay && relativeTime < endTime) {
					a.play();
				} else {
					a.pause();
				}
			}

			for (const a of word.maskAnimations) {
				const t = Math.min(this.totalDuration, maskRelativeTime);
				a.currentTime = t;
				a.playbackRate = 1;

				const timing = a.effect?.getComputedTiming();
				const duration = (timing?.duration as number) || 0;
				const delay = (timing?.delay as number) || 0;
				const endTime = delay + duration;

				if (shouldPlay && t < endTime) {
					a.play();
				} else {
					a.pause();
				}
			}
		}
		main.classList.add(styles.active);
	}

	disable() {
		this.isEnabled = false;
		this.element.classList.remove(styles.active);
		this.renderMode = LyricLineRenderMode.SOLID;

		const main = this.element.children[0] as HTMLDivElement;

		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				if (
					a.id === "float-word" ||
					a.id.includes("emphasize-word-float-only")
				) {
					a.playbackRate = -1;
					a.play();
				}
			}

			for (const a of word.maskAnimations) {
				a.pause();
			}
		}
		main.classList.remove(styles.active);
	}

	private lastWord?: RealWord;

	async resume() {
		if (!this.isEnabled) return;
		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				if (
					!this.lastWord ||
					this.splittedWords.indexOf(this.lastWord) <
						this.splittedWords.indexOf(word)
				) {
					const timing = a.effect?.getComputedTiming();
					const duration = (timing?.duration as number) || 0;
					const delay = (timing?.delay as number) || 0;
					const endTime = delay + duration;
					const currentTime = (a.currentTime as number) || 0;

					if (a.playState !== "finished" && currentTime < endTime) {
						a.play();
					}
				}
			}

			for (const a of word.maskAnimations) {
				if (
					!this.lastWord ||
					this.splittedWords.indexOf(this.lastWord) <
						this.splittedWords.indexOf(word)
				) {
					const timing = a.effect?.getComputedTiming();
					const duration = (timing?.duration as number) || 0;
					const delay = (timing?.delay as number) || 0;
					const endTime = delay + duration;

					const currentTime = (a.currentTime as number) || 0;

					if (a.playState !== "finished" && currentTime < endTime) {
						a.play();
					}
				}
			}
		}
	}

	async pause() {
		if (!this.isEnabled) return;
		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				a.pause();
			}
			for (const a of word.maskAnimations) {
				a.pause();
			}
		}
	}
	setMaskAnimationState(maskAnimationTime = 0) {
		const t = maskAnimationTime - this.lyricLine.startTime;
		for (const word of this.splittedWords) {
			for (const a of word.maskAnimations) {
				a.currentTime = Math.min(this.totalDuration, Math.max(0, t));
				a.playbackRate = 1;
				if (t >= 0 && t < this.totalDuration) a.play();
				else a.pause();
			}
		}
	}

	getLine() {
		return this.lyricLine;
	}
	// private _hide = true;
	private _prevParentEl: HTMLElement;
	private lastStyle = "";
	show() {
		// this._hide = false;
		if (!this.element.parentElement) {
			this._prevParentEl.appendChild(this.element);
			this.lyricPlayer.resizeObserver.observe(this.element);
		}
		if (!this.built) {
			this.rebuildElement();
			this.built = true;
			this.updateMaskImageSync();
		}
		this.rebuildStyle();
	}
	hide() {
		// this._hide = true;
		if (this.element.parentElement) {
			this._prevParentEl.removeChild(this.element);
			this.lyricPlayer.resizeObserver.unobserve(this.element);
		}
		if (this.built) {
			this.disposeElements();
			this.built = false;
		}
	}
	// 方案二：批量样式更新优化
	private pendingStyleUpdate = false;
	private cachedStyle = {
		posY: 0,
		scale: 100,
		blur: 0,
	};

	/**
	 * 标记需要样式更新，由 LyricPlayer 批量调度
	 */
	markStyleUpdateNeeded() {
		this.pendingStyleUpdate = true;
	}

	/**
	 * 执行实际的样式更新（在 requestAnimationFrame 中调用）
	 */
	flushStyles() {
		if (!this.pendingStyleUpdate) return;
		this.pendingStyleUpdate = false;

		const style = this.buildStyleString();
		if (style !== this.lastStyle) {
			this.lastStyle = style;
			this.element.setAttribute("style", style);
		}
	}

	/**
	 * 构建样式字符串
	 */
	private buildStyleString(): string {
		const { posY, scale } = this.cachedStyle;
		let style = `transform:translateY(${posY.toFixed(1)}px) scale(${(scale / 100).toFixed(4)});`;
		if (!this.lyricPlayer.getEnableSpring() && this.isInSight) {
			style += `transition-delay:${this.delay}ms;`;
		}
		style += `filter:blur(${Math.min(5, this.cachedStyle.blur).toFixed(3)}px);`;
		return style;
	}

	private rebuildStyle() {
		let style = "";
		style += `transform:translateY(${this.lineTransforms.posY
			.getCurrentPosition()
			.toFixed(
				1,
			)}px) scale(${(this.lineTransforms.scale.getCurrentPosition() / 100).toFixed(4)});`;
		if (!this.lyricPlayer.getEnableSpring() && this.isInSight) {
			style += `transition-delay:${this.delay}ms;`;
		}
		style += `filter:blur(${Math.min(5, this.blur)}px);`;
		if (style !== this.lastStyle) {
			this.lastStyle = style;
			this.element.setAttribute("style", style);
		}
	}

	override rebuildElement() {
		this.disposeElements();
		const main = this.element.children[0] as HTMLDivElement;
		const trans = this.element.children[1] as HTMLDivElement;
		const roman = this.element.children[2] as HTMLDivElement;
		// 非动态歌词，直接渲染整行与副行
		if (this.lyricPlayer._getIsNonDynamic()) {
			main.innerText = this.lyricLine.words.map((w) => w.word).join("");
			this.setSubLinesText(trans, roman);
			return;
		}

		const chunkedWords = chunkAndSplitLyricWords(this.lyricLine.words);
		const hasRubyLine = this.lyricLine.words.some(
			(word) => (word.ruby?.length ?? 0) > 0,
		);
		const hasRomanLine = this.lyricLine.words.some(
			(word) => (word.romanWord?.trim().length ?? 0) > 0,
		);
		main.innerHTML = "";

		// 首先将 chunkedWords 完全扁平化为单个单词数组
		const flatWords: LyricWord[] = [];
		for (const chunk of chunkedWords) {
			if (Array.isArray(chunk)) {
				flatWords.push(...chunk);
			} else {
				flatWords.push(chunk);
			}
		}

		// 处理 Ruby 短语合并
		const resultWords: (LyricWord | LyricWord[])[] = [];
		let i = 0;
		while (i < flatWords.length) {
			const word = flatWords[i];
			const hasRuby = (word.ruby?.length ?? 0) > 0;

			// 如果是 ruby 短语起始，收集整个短语
			if (hasRuby && word.rubyPhraseStart) {
				const rubyPhrase: LyricWord[] = [word];
				i++;

				// 向后搜寻需要合并的 ruby 单词（必须连续有 ruby 且不是新的短语起始）
				while (i < flatWords.length) {
					const nextWord = flatWords[i];
					const nextHasRuby = (nextWord.ruby?.length ?? 0) > 0;

					// 只有当下一个单词有 ruby 且不是短语起始时才合并
					if (nextHasRuby && !nextWord.rubyPhraseStart) {
						rubyPhrase.push(nextWord);
						i++;
					} else {
						break;
					}
				}

				resultWords.push(rubyPhrase);
			} else {
				resultWords.push(word);
				i++;
			}
		}

		for (const item of resultWords) {
			this.buildWord(item, main, hasRubyLine, hasRomanLine);
		}

		this.setSubLinesText(trans, roman);
	}

	/** 设置翻译与音译行文本 */
	private setSubLinesText(trans: HTMLDivElement, roman: HTMLDivElement) {
		trans.innerText = this.lyricLine.translatedLyric;
		roman.innerText = this.lyricLine.romanLyric;
	}

	private getRubyCharCount(word: LyricWord) {
		return (word.ruby ?? []).reduce(
			(total, ruby) => total + ruby.word.length,
			0,
		);
	}

	private getRubySegments(word: LyricWord) {
		return (word.ruby ?? []).filter(
			(ruby) => (ruby?.word?.trim().length ?? 0) > 0,
		);
	}



	private createWord(
		word: LyricWord,
		shouldEmphasize: boolean,
		hasRubyLine: boolean,
		hasRomanLine: boolean,
	): RealWord {
		const mainWordEl = document.createElement("span");
		const subElements: HTMLSpanElement[] = [];
		const romanWord = word.romanWord?.trim() ?? "";
		const wordContainer = hasRubyLine
			? document.createElement("div")
			: mainWordEl;
		let rubyWordEl: HTMLDivElement | undefined;

		if (hasRubyLine) {
			rubyWordEl = document.createElement("div");
			const rubySegments = this.getRubySegments(word);
			for (const ruby of rubySegments) {
				const rubyPartEl = document.createElement("span");
				rubyPartEl.innerText = ruby.word;
				rubyPartEl.dataset.startTime = String(ruby.startTime);
				rubyPartEl.dataset.endTime = String(ruby.endTime);
				rubyWordEl.appendChild(rubyPartEl);
			}
			rubyWordEl.classList.add(styles.rubyWord);
			mainWordEl.classList.add(styles.wordWithRuby);
			wordContainer.classList.add(styles.wordBody);
			mainWordEl.appendChild(rubyWordEl);
			mainWordEl.appendChild(wordContainer);
		}

		// 创建 span 包裹单词内容，保持 DOM 结构一致性
		const wordContentEl = hasRubyLine ? document.createElement("span") : wordContainer;
		if (hasRubyLine) {
			wordContainer.appendChild(wordContentEl);
		}

		// 总是创建字符级别的元素，用于字符级动画
		const wordEl = document.createElement("div");
		for (const char of word.word.trim()) {
			const charEl = document.createElement("span");
			charEl.innerText = char;
			subElements.push(charEl);
			wordEl.appendChild(charEl);
		}
		wordContentEl.appendChild(wordEl);

		if (shouldEmphasize) {
			mainWordEl.classList.add(styles.emphasize);
		}

		if (hasRomanLine) {
			const romanWordEl = document.createElement("div");
			romanWordEl.classList.add(styles.romanWord);
			// 在 romanWord 内部添加一层 span 包裹音译内容
			const romanWordSpan = document.createElement("span");
			romanWordSpan.innerText = romanWord.length > 0 ? romanWord : "\u00A0";
			romanWordEl.appendChild(romanWordSpan);
			wordContentEl.appendChild(romanWordEl);
		}

		const realWord: RealWord = {
			...word,
			mainElement: mainWordEl,
			subElements: subElements,
			elementAnimations: this.initFloatAnimation(word, subElements),
			maskAnimations: [],
			width: 0,
			height: 0,
			padding: 0,
			shouldEmphasize: shouldEmphasize,
		};

		return realWord;
	}

	private buildWord(
		input: LyricWord | LyricWord[],
		main: HTMLDivElement,
		hasRubyLine: boolean,
		hasRomanLine: boolean,
	) {
		const chunk = Array.isArray(input) ? input : [input];
		if (chunk.length === 0) return;

		const isPureSpace = chunk.every((w) => !w.word.trim());
		if (isPureSpace) {
			const textContent = chunk.map((w) => w.word).join("");
			main.appendChild(document.createTextNode(textContent));
			return;
		}

		const merged = chunk.reduce(
			(a, b) => {
				a.endTime = Math.max(a.endTime, b.endTime);
				a.startTime = Math.min(a.startTime, b.startTime);
				a.word += b.word;
				return a;
			},
			{
				word: "",
				romanWord: "",
				startTime: Number.POSITIVE_INFINITY,
				endTime: Number.NEGATIVE_INFINITY,
				wordType: "normal",
				obscene: false,
			} as LyricWord,
		);

		let emp = chunk.some((word) => LyricLineBase.shouldEmphasize(word));
		if (!isCJK(merged.word)) {
			emp = emp || LyricLineBase.shouldEmphasize(merged);
		}

		const wrapperWordEl = document.createElement("span");
		wrapperWordEl.classList.add(styles.emphasizeWrapper);

		const characterElements: HTMLElement[] = [];

		// 检查是否是 ruby 短语（多个单词共享 ruby）
		const isRubyPhrase = chunk.length > 1 && chunk.some(w => (w.ruby?.length ?? 0) > 0);

		if (isRubyPhrase) {
			// 创建合并的 ruby 短语 DOM
			const realWord = this.createRubyPhraseWord(chunk, emp, hasRubyLine, hasRomanLine);

			if (emp) {
				characterElements.push(...realWord.subElements);
			}

			this.splittedWords.push(realWord);
			wrapperWordEl.appendChild(realWord.mainElement);
		} else {
			// 普通单词处理
			for (const word of chunk) {
				if (!word.word.trim()) {
					wrapperWordEl.appendChild(document.createTextNode(word.word));
					continue;
				}

				// 创建新的 word
				const realWord = this.createWord(word, emp, hasRubyLine, hasRomanLine);

				if (emp) {
					characterElements.push(...realWord.subElements);
				}

				this.splittedWords.push(realWord);
				wrapperWordEl.appendChild(realWord.mainElement);
			}
		}

		if (emp && this.splittedWords.length > 0) {
			const lastWordOfChunk = this.splittedWords[this.splittedWords.length - 1];
			const rubyCharCount = chunk.reduce(
				(total, word) => total + this.getRubyCharCount(word),
				0,
			);

			lastWordOfChunk.elementAnimations.push(
				...this.initEmphasizeAnimation(
					merged,
					characterElements,
					merged.endTime - merged.startTime,
					merged.startTime - this.lyricLine.startTime,
					rubyCharCount,
				),
			);
		}

		main.appendChild(wrapperWordEl);
	}

	/**
	 * 创建合并的 ruby 短语单词
	 * 将多个共享 ruby 的单词合并成一个 DOM 结构
	 */
	private createRubyPhraseWord(
		words: LyricWord[],
		shouldEmphasize: boolean,
		hasRubyLine: boolean,
		hasRomanLine: boolean,
	): RealWord {
		const mainWordEl = document.createElement("span");
		const subElements: HTMLSpanElement[] = [];

		const wordContainer = hasRubyLine
			? document.createElement("div")
			: mainWordEl;
		let rubyWordEl: HTMLDivElement | undefined;

		if (hasRubyLine) {
			rubyWordEl = document.createElement("div");
			// 合并所有单词的 ruby
			for (const word of words) {
				const rubySegments = this.getRubySegments(word);
				for (const ruby of rubySegments) {
					const rubyPartEl = document.createElement("span");
					rubyPartEl.innerText = ruby.word;
					rubyPartEl.dataset.startTime = String(ruby.startTime);
					rubyPartEl.dataset.endTime = String(ruby.endTime);
					rubyWordEl.appendChild(rubyPartEl);
				}
			}
			rubyWordEl.classList.add(styles.rubyWord);
			mainWordEl.classList.add(styles.wordWithRuby);
			wordContainer.classList.add(styles.wordBody);
			mainWordEl.appendChild(rubyWordEl);
			mainWordEl.appendChild(wordContainer);
		}

		// 创建每个单词的内容
		for (const word of words) {
			const wordContentEl = document.createElement("span");
			const romanWord = word.romanWord?.trim() ?? "";

			// 保存时间信息到 dataset，供动画使用
			wordContentEl.dataset.startTime = String(word.startTime);
			wordContentEl.dataset.endTime = String(word.endTime);

			// 总是创建字符级别的元素，用于字符级动画
			const wordEl = document.createElement("div");
			for (const char of word.word.trim()) {
				const charEl = document.createElement("span");
				charEl.innerText = char;
				subElements.push(charEl);
				wordEl.appendChild(charEl);
			}
			wordContentEl.appendChild(wordEl);

			if (shouldEmphasize) {
				wordContentEl.classList.add(styles.emphasize);
			}

			if (hasRomanLine) {
				const romanWordEl = document.createElement("div");
				romanWordEl.classList.add(styles.romanWord);
				const romanWordSpan = document.createElement("span");
				romanWordSpan.innerText = romanWord.length > 0 ? romanWord : "\u00A0";
				romanWordEl.appendChild(romanWordSpan);
				wordContentEl.appendChild(romanWordEl);
			}

			wordContainer.appendChild(wordContentEl);
		}

		// 使用第一个单词的信息作为基础
		const firstWord = words[0];
		const realWord: RealWord = {
			...firstWord,
			mainElement: mainWordEl,
			subElements: subElements,
			elementAnimations: this.initFloatAnimation(firstWord, subElements),
			maskAnimations: [],
			width: 0,
			height: 0,
			padding: 0,
			shouldEmphasize: shouldEmphasize,
		};

		return realWord;
	}

	private initFloatAnimation(word: LyricWord, subElements: HTMLSpanElement[]): Animation[] {
		const baseDelay = word.startTime - this.lyricLine.startTime;
		const duration = Math.max(1000, word.endTime - word.startTime);
		let up = 0.05;
		if (this.lyricLine.isBG) {
			up *= 2;
		}

		// 如果没有子元素（空格等情况），返回空数组
		if (subElements.length === 0) {
			return [];
		}

		// 为每个字符创建独立的浮动动画，依次延迟
		return subElements.map((charEl, i) => {
			const charDelay = baseDelay + (duration / 2.5 / subElements.length) * i;
			const a = charEl.animate(
				[
					{
						transform: "translateY(0px)",
					},
					{
						transform: `translateY(${-up}em)`,
					},
				],
				{
					duration: Number.isFinite(duration) ? duration : 0,
					delay: Number.isFinite(charDelay) ? charDelay : 0,
					id: "float-word",
					composite: "add",
					fill: "both",
					easing: "ease-out",
				},
			);
			a.pause();
			return a;
		});
	}
	// 按照原 Apple Music 参考，强调效果只应用缩放、轻微左右位移和辉光效果，原主要的悬浮位移效果不变
	// 为了避免产生锯齿抖动感，使用 matrix3d 来实现缩放和位移
	private initEmphasizeAnimation(
		word: LyricWord,
		characterElements: HTMLElement[],
		duration: number,
		delay: number,
		rubyCharCount: number,
	): Animation[] {
		const de = Math.max(0, delay);
		let du = Math.max(1000, duration);
		const anchorCharCount =
			rubyCharCount > 0 ? rubyCharCount : Math.max(1, characterElements.length);

		let result: Animation[] = [];

		let amount = du / 2000;
		amount = amount > 1 ? Math.sqrt(amount) : amount ** 3;
		let blur = du / 3000;
		blur = blur > 1 ? Math.sqrt(blur) : blur ** 3;
		amount *= 0.6;
		blur *= 0.5;
		if (
			this.lyricLine.words.length > 0 &&
			word.word.includes(
				this.lyricLine.words[this.lyricLine.words.length - 1].word,
			)
		) {
			amount *= 1.6;
			blur *= 1.5;
			du *= 1.2;
		}
		amount = Math.min(1.2, amount);
		blur = Math.min(0.8, blur);

		const animateDu = Number.isFinite(du) ? du : 0;
		const empEasing = makeEmpEasing(EMP_EASING_MID);

		result = characterElements.flatMap((el, i, arr) => {
			const wordDe = de + (du / 2.5 / anchorCharCount) * i;
			const result: Animation[] = [];

			const frames: Keyframe[] = new Array(ANIMATION_FRAME_QUANTITY)
				.fill(0)
				.map((_, j) => {
					const x = (j + 1) / ANIMATION_FRAME_QUANTITY;
					const transX = empEasing(x);
					const glowLevel = empEasing(x) * blur;

					const mat = scaleMatrix4(createMatrix4(), 1 + transX * 0.1 * amount);
					const offsetX = -transX * 0.03 * amount * (arr.length / 2 - i);
					const offsetY = -transX * 0.025 * amount;

					return {
						offset: x,
						transform: `${matrix4ToCSS(
							mat,
							4,
						)} translate(${offsetX}em, ${offsetY}em)`,
						textShadow: `0 0 ${Math.min(
							0.3,
							blur * 0.3,
						)}em rgba(255, 255, 255, ${glowLevel})`,
					};
				});

			const glow = el.animate(frames, {
				duration: animateDu,
				delay: Number.isFinite(wordDe) ? wordDe : 0,
				id: `emphasize-word-${el.innerText}-${i}`,
				iterations: 1,
				composite: "replace",
				fill: "both",
			});
			glow.onfinish = () => {
				glow.pause();
			};
			glow.pause();
			result.push(glow);

			const floatFrame: Keyframe[] = new Array(ANIMATION_FRAME_QUANTITY)
				.fill(0)
				.map((_, j) => {
					const x = (j + 1) / ANIMATION_FRAME_QUANTITY;
					let y = Math.sin(x * Math.PI);
					// y = x < 0.5 ? y : Math.max(y, 1.0);
					if (this.lyricLine.isBG) {
						y *= 2;
					}

					return {
						offset: x,
						transform: `translateY(${-y * 0.05}em)`,
					};
				});
			const float = el.animate(floatFrame, {
				duration: animateDu * 1.4,
				delay: Number.isFinite(wordDe) ? wordDe - 400 : 0,
				id: "emphasize-word-float",
				iterations: 1,
				composite: "add",
				fill: "both",
			});
			float.onfinish = () => {
				float.pause();
			};
			float.pause();
			result.push(float);

			return result;
		});

		return result;
	}

	private get totalDuration() {
		return this.lyricLine.endTime - this.lyricLine.startTime;
	}

	override onLineSizeChange(_size: [number, number]) {
		this.updateMaskImageSync();
	}
	updateMaskImageSync() {
		for (const word of this.splittedWords) {
			const el = word.mainElement;
			if (el) {
				word.padding = Number.parseFloat(getComputedStyle(el).paddingLeft);
				word.width = el.clientWidth - word.padding * 2;
				word.height = el.clientHeight - word.padding * 2;
			} else {
				word.width = 0;
				word.height = 0;
				word.padding = 0;
			}
		}
		if (this.lyricPlayer.supportMaskImage) {
			this.generateWebAnimationBasedMaskImage();
		} else {
			this.generateCalcBasedMaskImage();
		}
		if (this.isEnabled) {
			const isPlayerRunning = this.lyricPlayer.getIsPlaying?.() ?? true;
			this.enable(this.lyricPlayer.getCurrentTime(), isPlayerRunning);
		}
	}

	private generateCalcBasedMaskImage() {
		for (const word of this.splittedWords) {
			const wordEl = word.mainElement;
			if (wordEl) {
				word.width = wordEl.clientWidth;
				word.height = wordEl.clientHeight;
				const fadeWidth = word.height * this.lyricPlayer.getWordFadeWidth();
				const [maskImage, totalAspect] = generateFadeGradient(
					fadeWidth / word.width,
				);
				const totalAspectStr = `${totalAspect * 100}% 100%`;
				if (this.lyricPlayer.supportMaskImage) {
					wordEl.style.maskImage = maskImage;
					wordEl.style.maskRepeat = "no-repeat";
					wordEl.style.maskOrigin = "left";
					wordEl.style.maskSize = totalAspectStr;
				} else {
					wordEl.style.webkitMaskImage = maskImage;
					wordEl.style.webkitMaskRepeat = "no-repeat";
					wordEl.style.webkitMaskOrigin = "left";
					wordEl.style.webkitMaskSize = totalAspectStr;
				}
				const w = word.width + fadeWidth;
				const maskPos = `clamp(${-w}px,calc(${-w}px + (var(--amll-player-time) - ${
					word.startTime
				})*${
					w / Math.abs(word.endTime - word.startTime)
				}px),0px) 0px, left top`;
				wordEl.style.maskPosition = maskPos;
				wordEl.style.webkitMaskPosition = maskPos;
			}
		}
	}

	private generateWebAnimationBasedMaskImage() {
		// 因为歌词行有可能比行内单词的结束时间早，有可能导致过渡动画提早停止出现瑕疵
		// 所以要以单词的结束时间为准
		const totalFadeDuration =
			Math.max(
				this.splittedWords.reduce((pv, w) => Math.max(w.endTime, pv), 0),
				this.lyricLine.endTime,
			) - this.lyricLine.startTime;

		this.splittedWords.forEach((word, i) => {
			const wordEl = word.mainElement;
			if (!wordEl) return;

			const fadeWidth = word.height * this.lyricPlayer.getWordFadeWidth();

			// 取消之前的动画
			for (const a of word.maskAnimations) {
				a.cancel();
			}
			word.maskAnimations = [];

			// 为单词创建动画
			this.createWordAnimation(word, wordEl, totalFadeDuration, fadeWidth, i);
		});
	}

	/**
	 * 应用遮罩动画到指定元素
	 */
	private applyMaskAnimation(
		element: HTMLDivElement,
		startTime: number,
		endTime: number,
		totalFadeDuration: number,
		fadeWidth: number,
		word: RealWord,
		animationId: string,
	) {
		const wordWidth = element.clientWidth || 0;

		const [maskImage, totalAspect] = generateFadeGradient(
			fadeWidth / Math.max(1, wordWidth),
		);
		const totalAspectStr = `${totalAspect * 100}% 100%`;

		// 设置遮罩样式
		if (this.lyricPlayer.supportMaskImage) {
			element.style.maskImage = maskImage;
			element.style.maskRepeat = "no-repeat";
			element.style.maskOrigin = "left";
			element.style.maskSize = totalAspectStr;
		} else {
			element.style.webkitMaskImage = maskImage;
			element.style.webkitMaskRepeat = "no-repeat";
			element.style.webkitMaskOrigin = "left";
			element.style.webkitMaskSize = totalAspectStr;
		}

		const minOffset = -(wordWidth + fadeWidth);
		const clampOffset = (x: number) => Math.max(minOffset, Math.min(0, x));

		// 生成动画帧
		const frames: Keyframe[] = [];
		const wordStartStamp = startTime - this.lyricLine.startTime;
		const wordEndStamp = endTime - this.lyricLine.startTime;

		// 初始状态（遮罩在左侧外）
		frames.push({
			offset: 0,
			maskPosition: `${clampOffset(-wordWidth - fadeWidth)}px 0`,
		});

		// 开始时间前保持隐藏
		const startOffset = Math.max(0, wordStartStamp / totalFadeDuration);
		if (startOffset > 0) {
			frames.push({
				offset: startOffset,
				maskPosition: `${clampOffset(-wordWidth - fadeWidth)}px 0`,
			});
		}

		// 动画过程：从左侧外移动到完全显示
		const endOffset = Math.min(1, wordEndStamp / totalFadeDuration);
		frames.push({
			offset: endOffset,
			maskPosition: `${clampOffset(fadeWidth * 0.5)}px 0`,
		});

		// 保持显示状态到结束
		if (endOffset < 1) {
			frames.push({
				offset: 1,
				maskPosition: `${clampOffset(fadeWidth * 0.5)}px 0`,
			});
		}

		try {
			const ani = element.animate(frames, {
				duration: totalFadeDuration || 1,
				id: animationId,
				fill: "both",
			});
			ani.pause();
			word.maskAnimations.push(ani);
		} catch (err) {
			console.warn("应用遮罩渐变动画发生错误", frames, totalFadeDuration, err);
		}
	}

	/**
	 * 为普通单词创建动画
	 */
	private createWordAnimation(
		word: RealWord,
		wordEl: HTMLSpanElement,
		totalFadeDuration: number,
		fadeWidth: number,
		index: number,
	) {
		// 检查是否是 ruby 短语（有 wordBody 结构）
		const wordBodyEl = wordEl.querySelector(`.${styles.wordBody}`) as HTMLDivElement | null;
		const rubyWordEl = wordEl.querySelector(`.${styles.rubyWord}`) as HTMLDivElement | null;

		if (wordBodyEl && rubyWordEl) {
			// 处理 ruby 短语：为每个子单词和 ruby 字符创建动画
			this.createRubyPhraseAnimation(word, wordEl, wordBodyEl, rubyWordEl, totalFadeDuration, fadeWidth, index);
		} else {
			// 普通单词处理
			// 获取包裹原文的 div（第一个子 div）
			const baseTextEl = wordEl.querySelector("div:first-child") as HTMLDivElement | null;
			if (!baseTextEl) return;

			// 获取 romanWord 内部的 span（如果有）
			const romanWordSpan = wordEl.querySelector(`.${styles.romanWord} > span`) as HTMLSpanElement | null;

			// 为包裹原文的 div 创建动画
			this.applyMaskAnimationToElement(
				baseTextEl,
				word.startTime,
				word.endTime,
				totalFadeDuration,
				fadeWidth,
				word,
				`fade-word-base-${word.word}-${index}`,
			);

			// 为 romanWord 内部的 span 创建动画（如果存在）
			if (romanWordSpan) {
				this.applyMaskAnimationToElement(
					romanWordSpan as unknown as HTMLDivElement,
					word.startTime,
					word.endTime,
					totalFadeDuration,
					fadeWidth,
					word,
					`fade-word-roman-${word.word}-${index}`,
				);
			}
		}
	}

	/**
	 * 为 ruby 短语创建动画
	 * 优化版：将动画应用到 rubyWord 父节点，而不是每个字符，减少 Animation 对象数量
	 */
	private createRubyPhraseAnimation(
		word: RealWord,
		_wordEl: HTMLSpanElement,
		wordBodyEl: HTMLDivElement,
		rubyWordEl: HTMLDivElement,
		totalFadeDuration: number,
		fadeWidth: number,
		index: number,
	) {
		// 获取所有 wordBody 下的子元素（每个子元素代表一个单词）
		const wordSpans = Array.from(wordBodyEl.children) as HTMLSpanElement[];

		// 为 rubyWord 父节点创建单个动画（替代为每个字符创建动画）
		this.applyMaskAnimationToRubyContainer(
			rubyWordEl,
			totalFadeDuration,
			fadeWidth,
			word,
			`fade-ruby-container-${index}`,
		);

		// 为每个子单词创建动画
		for (let i = 0; i < wordSpans.length; i++) {
			const wordSpan = wordSpans[i];
			// 获取原文 div（第一个子 div）
			const baseTextEl = wordSpan.querySelector("div:first-child") as HTMLDivElement | null;
			// 获取 romanWord 内部的 span
			const romanWordSpan = wordSpan.querySelector(`.${styles.romanWord} > span`) as HTMLSpanElement | null;

			// 从 dataset 获取时间，或使用默认时间
			const startTime = Number(wordSpan.dataset.startTime || word.startTime);
			const endTime = Number(wordSpan.dataset.endTime || word.endTime);

			if (baseTextEl) {
				this.applyMaskAnimation(
					baseTextEl,
					startTime,
					endTime,
					totalFadeDuration,
					fadeWidth,
					word,
					`fade-word-base-${index}-${i}`,
				);
			}

			if (romanWordSpan) {
				this.applyMaskAnimation(
					romanWordSpan as unknown as HTMLDivElement,
					startTime,
					endTime,
					totalFadeDuration,
					fadeWidth,
					word,
					`fade-word-roman-${index}-${i}`,
				);
			}
		}
	}

	/**
	 * 为 Ruby 容器创建单个遮罩动画
	 * 通过分段关键帧实现逐字显示效果，但只使用一个 Animation 对象
	 */
	private applyMaskAnimationToRubyContainer(
		containerEl: HTMLDivElement,
		totalFadeDuration: number,
		fadeWidth: number,
		word: RealWord,
		animationId: string,
	) {
		// 获取所有 ruby 字符信息
		const rubySpans = Array.from(containerEl.children) as HTMLSpanElement[];
		if (rubySpans.length === 0) return;

		// 计算每个字符的宽度和时间信息
		const charInfos = rubySpans.map((span) => ({
			startTime: Number(span.dataset.startTime || word.startTime),
			endTime: Number(span.dataset.endTime || word.endTime),
			width: span.clientWidth,
		}));

		const containerWidth = containerEl.clientWidth;

		const [maskImage, totalAspect] = generateFadeGradient(
			fadeWidth / Math.max(1, containerWidth),
		);
		const totalAspectStr = `${totalAspect * 100}% 100%`;

		// 应用遮罩样式到父节点
		if (this.lyricPlayer.supportMaskImage) {
			containerEl.style.maskImage = maskImage;
			containerEl.style.maskRepeat = "no-repeat";
			containerEl.style.maskOrigin = "left";
			containerEl.style.maskSize = totalAspectStr;
		} else {
			containerEl.style.webkitMaskImage = maskImage;
			containerEl.style.webkitMaskRepeat = "no-repeat";
			containerEl.style.webkitMaskOrigin = "left";
			containerEl.style.webkitMaskSize = totalAspectStr;
		}

		const minOffset = -(containerWidth + fadeWidth);
		const clampOffset = (x: number) => Math.max(minOffset, Math.min(0, x));

		let curPos = -containerWidth - fadeWidth;
		let timeOffset = 0;
		const frames: Keyframe[] = [];

		const pushFrame = () => {
			const time = Math.max(0, Math.min(1, timeOffset));
			const value = `${clampOffset(curPos)}px 0`;
			frames.push({ offset: time, maskPosition: value });
		};

		// 初始帧（全部隐藏）
		pushFrame();

		// 按时间顺序为每个字符创建关键帧段
		let lastTimeStamp = 0;
		charInfos.forEach((charInfo, i) => {
			const charStartStamp = charInfo.startTime - this.lyricLine.startTime;
			const charEndStamp = charInfo.endTime - this.lyricLine.startTime;

			// 段1：等待当前字符开始（停顿阶段）
			const waitDuration = charStartStamp - lastTimeStamp;
			if (waitDuration > 0) {
				timeOffset += waitDuration / totalFadeDuration;
				pushFrame();
			}

			// 段2：字符显示期间，移动遮罩
			// 移动距离 = 当前字符宽度 + 渐变宽度调整
			const moveDistance = charInfo.width + (i === 0 ? fadeWidth * 1.5 : fadeWidth * 0.5);
			curPos += moveDistance;

			const charDuration = charInfo.endTime - charInfo.startTime;
			timeOffset += charDuration / totalFadeDuration;
			pushFrame();

			lastTimeStamp = charEndStamp;
		});

		// 保持显示到结束
		if (timeOffset < 1) {
			timeOffset = 1;
			pushFrame();
		}

		try {
			const ani = containerEl.animate(frames, {
				duration: totalFadeDuration || 1,
				id: animationId,
				fill: "both",
			});
			ani.pause();
			word.maskAnimations.push(ani);
		} catch (err) {
			console.warn("应用 Ruby 容器渐变动画发生错误", frames, totalFadeDuration, err);
		}
	}

	/**
	 * 应用遮罩动画到指定元素（用于没有 ruby 的单词）
	 */
	private applyMaskAnimationToElement(
		element: HTMLDivElement,
		startTime: number,
		endTime: number,
		totalFadeDuration: number,
		fadeWidth: number,
		word: RealWord,
		animationId: string,
	) {
		const elementWidth = element.clientWidth || 0;
		const elementPadding = 0; // 简化处理，没有额外的 padding

		const [maskImage, totalAspect] = generateFadeGradient(
			fadeWidth / Math.max(1, elementWidth),
		);
		const totalAspectStr = `${totalAspect * 100}% 100%`;

		if (this.lyricPlayer.supportMaskImage) {
			element.style.maskImage = maskImage;
			element.style.maskRepeat = "no-repeat";
			element.style.maskOrigin = "left";
			element.style.maskSize = totalAspectStr;
		} else {
			element.style.webkitMaskImage = maskImage;
			element.style.webkitMaskRepeat = "no-repeat";
			element.style.webkitMaskOrigin = "left";
			element.style.webkitMaskSize = totalAspectStr;
		}

		const minOffset = -(elementWidth + elementPadding * 2 + fadeWidth);
		const clampOffset = (x: number) => Math.max(minOffset, Math.min(0, x));

		let curPos = -elementWidth - elementPadding - fadeWidth;
		let timeOffset = 0;
		const frames: Keyframe[] = [];

		const pushFrame = () => {
			const time = Math.max(0, Math.min(1, timeOffset));
			const value = `${clampOffset(curPos)}px 0`;
			frames.push({ offset: time, maskPosition: value });
		};

		pushFrame();

		// 停顿
		const wordStartStamp = startTime - this.lyricLine.startTime;
		timeOffset += wordStartStamp / totalFadeDuration;
		pushFrame();

		// 移动
		const wordDuration = endTime - startTime;
		timeOffset += wordDuration / totalFadeDuration;
		curPos += elementWidth;
		curPos += fadeWidth * 1.5;
		curPos += fadeWidth * 0.5;
		pushFrame();

		try {
			const ani = element.animate(frames, {
				duration: totalFadeDuration || 1,
				id: animationId,
				fill: "both",
			});
			ani.pause();
			word.maskAnimations.push(ani);
		} catch (err) {
			console.warn("应用单词渐变动画发生错误", frames, totalFadeDuration, err);
		}
	}
	getElement() {
		return this.element;
	}

	private updateMaskAlphaTargets(scale: number) {
		const factor = Math.max(0.0, Math.min(1.0, (scale - 0.97) / 0.03));
		const dynamicDarkAlpha = factor * 0.2 + 0.2;
		const dynamicBrightAlpha = factor * 0.8 + 0.2;

		if (this.renderMode === LyricLineRenderMode.SOLID) {
			this.targetBrightAlpha = dynamicDarkAlpha;
			this.targetDarkAlpha = dynamicDarkAlpha;
		} else {
			this.targetBrightAlpha = dynamicBrightAlpha;
			this.targetDarkAlpha = dynamicDarkAlpha;
		}
	}

	private applyAlphaToDom(delta: number) {
		const dt = delta || 0.016;
		const ATTACK_SPEED = 50.0;
		const RELEASE_SPEED = 7.0;
		const getFactor = (speed: number) => 1 - Math.exp(-speed * dt);

		// 根据即将变亮还是变暗选择速度
		// 如果即将变亮，让速度非常快，以免播放到第一个字的时候透明度还在慢慢增加导致看不清
		const isBrightening = this.targetBrightAlpha > this.currentBrightAlpha;
		const brightSpeed = isBrightening ? ATTACK_SPEED : RELEASE_SPEED;
		const brightFactor = getFactor(brightSpeed);

		if (Math.abs(this.targetBrightAlpha - this.currentBrightAlpha) < 0.001) {
			this.currentBrightAlpha = this.targetBrightAlpha;
		} else {
			this.currentBrightAlpha +=
				(this.targetBrightAlpha - this.currentBrightAlpha) * brightFactor;
		}

		const isDarkening = this.targetDarkAlpha > this.currentDarkAlpha;
		const darkSpeed = isDarkening ? ATTACK_SPEED : RELEASE_SPEED;
		const darkFactor = getFactor(darkSpeed);

		if (Math.abs(this.targetDarkAlpha - this.currentDarkAlpha) < 0.001) {
			this.currentDarkAlpha = this.targetDarkAlpha;
		} else {
			this.currentDarkAlpha +=
				(this.targetDarkAlpha - this.currentDarkAlpha) * darkFactor;
		}

		this.element.style.setProperty(
			"--bright-mask-alpha",
			this.currentBrightAlpha.toFixed(3),
		);
		this.element.style.setProperty(
			"--dark-mask-alpha",
			this.currentDarkAlpha.toFixed(3),
		);
	}

	override setTransform(
		top: number = this.top,
		scale: number = this.scale,
		opacity = 1,
		blur = 0,
		force = false,
		delay = 0,
		mode: LyricLineRenderMode = LyricLineRenderMode.SOLID,
	) {
		super.setTransform(top, scale, opacity, blur, force, delay);
		this.renderMode = mode;
		const beforeInSight = this.isInSight;
		const enableSpring = this.lyricPlayer.getEnableSpring();
		this.top = top;
		this.scale = scale;
		this.delay = (delay * 1000) | 0;
		const main = this.element.children[0] as HTMLDivElement;
		const trans = this.element.children[1] as HTMLDivElement;
		const roman = this.element.children[2] as HTMLDivElement;
		// main.style.opacity = `${opacity *
		// 	(!this.hasFaded ? 1 : this.lyricPlayer._getIsNonDynamic() ? 1 : 0.3)
		// 	}`;
		const subopacity =
			opacity * (this.lyricPlayer._getIsNonDynamic() ? 0.5 : 0.3);
		main.style.opacity = `${opacity}`;
		trans.style.opacity = `${subopacity}`;
		roman.style.opacity = `${subopacity}`;
		if (force || !enableSpring) {
			this.blur = Math.min(32, blur);
			// if (force) this.element.classList.add(styles.tmpDisableTransition);
			// this.lineWebAnimationTransforms.posX.setTargetPosition(left);
			// this.lineWebAnimationTransforms.posY.setTargetPosition(top);
			// this.lineWebAnimationTransforms.scale.setTargetPosition(scale);
			this.lineTransforms.posY.setPosition(top);
			this.lineTransforms.scale.setPosition(scale);
			if (!enableSpring) {
				const afterInSight = this.isInSight;
				if (beforeInSight || afterInSight) {
					this.show();
				} else {
					this.hide();
				}
			} else this.rebuildStyle();
			// if (force)
			// 	requestAnimationFrame(() => {
			// 		this.element.classList.remove(styles.tmpDisableTransition);
			// 	});
			const currentScale = this.lineTransforms.scale.getCurrentPosition();
			this.updateMaskAlphaTargets(currentScale / 100);
			this.currentBrightAlpha = this.targetBrightAlpha;
			this.currentDarkAlpha = this.targetDarkAlpha;
			this.element.style.setProperty(
				"--bright-mask-alpha",
				String(this.currentBrightAlpha),
			);
			this.element.style.setProperty(
				"--dark-mask-alpha",
				String(this.currentDarkAlpha),
			);
		} else {
			// this.lineWebAnimationTransforms.posX.stop();
			// this.lineWebAnimationTransforms.posY.stop();
			// this.lineWebAnimationTransforms.scale.stop();
			this.lineTransforms.posY.setTargetPosition(top, delay);
			this.lineTransforms.scale.setTargetPosition(scale);
			if (this.blur !== Math.min(5, blur)) {
				this.blur = Math.min(5, blur);
				const roundedBlur = blur.toFixed(3);
				this.element.style.filter = `blur(${roundedBlur}px)`;
			}
		}
	}

	update(delta = 0) {
		if (!this.lyricPlayer.getEnableSpring()) return;

		// 1. 更新弹簧计算（纯数学运算）
		this.lineTransforms.posY.update(delta);
		this.lineTransforms.scale.update(delta);

		// 2. 缓存计算结果
		this.cachedStyle.posY = this.lineTransforms.posY.getCurrentPosition();
		this.cachedStyle.scale = this.lineTransforms.scale.getCurrentPosition();

		// 3. 检查可见性变化
		const isInSight = this.isInSight;
		if (isInSight !== this._lastInSight) {
			this._lastInSight = isInSight;
			if (isInSight) this.show();
			else this.hide();
		}

		// 4. 计算透明度（仍然需要每帧更新，但延迟 DOM 写入）
		const currentScale = this.cachedStyle.scale / 100;
		this.updateMaskAlphaTargets(currentScale);
		this.applyAlphaToDom(delta);

		// 5. 标记需要样式更新，由 LyricPlayer 批量调度
		if (!this.pendingStyleUpdate) {
			this.pendingStyleUpdate = true;
			this.lyricPlayer.scheduleStyleUpdate(() => this.flushStyles());
		}
	}

	private _lastInSight = false;

	_getDebugTargetPos(): string {
		return `[位移: ${this.top}; 缩放: ${this.scale}; 延时: ${this.delay}]`;
	}

	get isInSight() {
		const t = this.lineTransforms.posY.getCurrentPosition();
		const h = this.lyricPlayer.lyricLinesSize.get(this)?.[1] ?? 0;
		const b = t + h;
		const pb = this.lyricPlayer.size[1];
		const ov = this.lyricPlayer.getOverscanPx();
		return !(t > pb + h + ov || b < -h - ov);
	}
	private disposeElements() {
		for (const realWord of this.splittedWords) {
			for (const a of realWord.elementAnimations) {
				a.cancel();
			}
			for (const a of realWord.maskAnimations) {
				a.cancel();
			}
			for (const sub of realWord.subElements) {
				sub.remove();
				sub.parentNode?.removeChild(sub);
			}
			realWord.elementAnimations = [];
			realWord.maskAnimations = [];
			realWord.subElements = [];
			if (realWord.mainElement?.parentNode) {
				realWord.mainElement.parentNode.removeChild(realWord.mainElement);
			}
		}
		this.splittedWords = [];
		const main = this.element.children[0] as HTMLDivElement;
		const trans = this.element.children[1] as HTMLDivElement;
		const roman = this.element.children[2] as HTMLDivElement;
		if (main) main.innerHTML = "";
		if (trans) trans.innerHTML = "";
		if (roman) roman.innerHTML = "";
	}
	override dispose(): void {
		this.disposeElements();
		this.lyricPlayer.resizeObserver.unobserve(this.element);
		this.element.remove();
	}
}
