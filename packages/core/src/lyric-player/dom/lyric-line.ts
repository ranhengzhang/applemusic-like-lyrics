import bezier from "bezier-easing";
import {
	type LyricLine,
	LyricLineRenderMode,
	type LyricWord,
	type LyricWordBase,
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
	/** rubyWord 元素，用于动画 */
	rubyWordEl?: HTMLDivElement;
	/** wordBody 元素，用于动画 */
	wordBodyEl?: HTMLDivElement;
	/** 被合并到该单词的其他单词（用于 ruby 短语） */
	mergedWords?: LyricWord[];
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

	// 跟踪最后一个创建的带有 ruby 的 wordWithRuby 元素，用于合并没有 rubyPhraseStart 的单词
	private lastWordWithRuby: {
		mainElement: HTMLSpanElement;
		rubyWordEl: HTMLDivElement;
		wordBodyEl: HTMLDivElement;
	} | null = null;

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
	private rebuildStyle() {
		let style = "";
		// if (this.lyricPlayer.getEnableSpring()) {
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
		// 重置 lastWordWithRuby，确保每行歌词开始时都是干净的状态
		this.lastWordWithRuby = null;
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

		for (const chunk of chunkedWords) {
			this.buildWord(chunk, main, hasRubyLine, hasRomanLine);
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

	/**
	 * 将单词合并到前一个 wordWithRuby 中
	 * 用于处理没有 rubyPhraseStart 标记的 ruby 单词
	 */
	private mergeWordToLastWordWithRuby(
		word: LyricWord,
		shouldEmphasize: boolean,
		hasRomanLine: boolean,
	) {
		if (!this.lastWordWithRuby) return;

		const { rubyWordEl, wordBodyEl } = this.lastWordWithRuby;
		const romanWord = word.romanWord?.trim() ?? "";

		// 合并 ruby 部分
		const rubySegments = this.getRubySegments(word);
		for (const ruby of rubySegments) {
			const rubyPartEl = document.createElement("span");
			rubyPartEl.innerText = ruby.word;
			rubyPartEl.dataset.startTime = String(ruby.startTime);
			rubyPartEl.dataset.endTime = String(ruby.endTime);
			rubyWordEl.appendChild(rubyPartEl);
		}

		// 创建 wordBody 的子元素
		const wordContentEl = document.createElement("span");

		if (shouldEmphasize) {
			wordContentEl.classList.add(styles.emphasize);
			for (const char of word.word.trim()) {
				const charEl = document.createElement("span");
				charEl.innerText = char;
				wordContentEl.appendChild(charEl);
			}
		} else {
			if (hasRomanLine) {
				const wordEl = document.createElement("div");
				wordEl.innerText = word.word.trim();
				wordContentEl.appendChild(wordEl);
			} else {
				// 总是创建一个 div 来包裹单词文本，保持 DOM 结构一致
				const wordEl = document.createElement("div");
				wordEl.innerText = word.word.trim();
				wordContentEl.appendChild(wordEl);
			}
		}

		// 添加 romanWord
		if (hasRomanLine) {
			const romanWordEl = document.createElement("div");
			romanWordEl.classList.add(styles.romanWord);
			// 在 romanWord 内部添加一层 span 包裹音译内容
			const romanWordSpan = document.createElement("span");
			romanWordSpan.innerText = romanWord.length > 0 ? romanWord : "\u00A0";
			romanWordEl.appendChild(romanWordSpan);
			wordContentEl.appendChild(romanWordEl);
		}

		wordBodyEl.appendChild(wordContentEl);
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

		if (shouldEmphasize) {
			mainWordEl.classList.add(styles.emphasize);
			// 创建一个 div 包裹所有字符，保持 DOM 结构一致性
			const wordEl = document.createElement("div");
			for (const char of word.word.trim()) {
				const charEl = document.createElement("span");
				charEl.innerText = char;
				subElements.push(charEl);
				wordEl.appendChild(charEl);
			}
			wordContentEl.appendChild(wordEl);
		} else {
			// 总是创建一个 div 来包裹单词文本，保持 DOM 结构一致
			const wordEl = document.createElement("div");
			wordEl.innerText = word.word.trim();
			wordContentEl.appendChild(wordEl);
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
			elementAnimations: [this.initFloatAnimation(word, mainWordEl)],
			maskAnimations: [],
			width: 0,
			height: 0,
			padding: 0,
			shouldEmphasize: shouldEmphasize,
			// 保存 rubyWord 和 wordBody 元素引用
			rubyWordEl: rubyWordEl,
			wordBodyEl: hasRubyLine ? (wordContainer as HTMLDivElement) : undefined,
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

		for (const word of chunk) {
			if (!word.word.trim()) {
				wrapperWordEl.appendChild(document.createTextNode(word.word));
				continue;
			}

			// 检查是否需要合并到前一个 wordWithRuby
			const hasRuby = (word.ruby?.length ?? 0) > 0;
			const shouldMerge = hasRuby && !word.rubyPhraseStart && this.lastWordWithRuby !== null;

			if (shouldMerge) {
				// 合并到前一个 wordWithRuby
				this.mergeWordToLastWordWithRuby(word, emp, hasRomanLine);
				// 将被合并的单词信息保存到最后一个 RealWord 中
				if (this.splittedWords.length > 0) {
					const lastRealWord = this.splittedWords[this.splittedWords.length - 1];
					if (!lastRealWord.mergedWords) {
						lastRealWord.mergedWords = [];
					}
					lastRealWord.mergedWords.push(word);
				}
			} else {
				// 创建新的 word
				const realWord = this.createWord(word, emp, hasRubyLine, hasRomanLine);

				if (emp) {
					characterElements.push(...realWord.subElements);
				}

				this.splittedWords.push(realWord);
				wrapperWordEl.appendChild(realWord.mainElement);

				// 如果是有 ruby 的单词，更新 lastWordWithRuby
				if (hasRuby) {
					const rubyWordEl = realWord.mainElement.querySelector(`.${styles.rubyWord}`) as HTMLDivElement;
					const wordBodyEl = realWord.mainElement.querySelector(`.${styles.wordBody}`) as HTMLDivElement;
					if (rubyWordEl && wordBodyEl) {
						this.lastWordWithRuby = {
							mainElement: realWord.mainElement,
							rubyWordEl,
							wordBodyEl,
						};
					}
				}
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

	private initFloatAnimation(word: LyricWord, wordEl: HTMLSpanElement) {
		const delay = word.startTime - this.lyricLine.startTime;
		const duration = Math.max(1000, word.endTime - word.startTime);
		let up = 0.05;
		if (this.lyricLine.isBG) {
			up *= 2;
		}
		const a = wordEl.animate(
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
				delay: Number.isFinite(delay) ? delay : 0,
				id: "float-word",
				composite: "add",
				fill: "both",
				easing: "ease-out",
			},
		);
		a.pause();
		return a;
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

		// 收集所有需要动画的单词（包括合并的 ruby 单词）
		const animatedWords: RealWord[] = [];
		for (const word of this.splittedWords) {
			// 只处理有 ruby 且是短语起始的单词，或者没有 ruby 的单词
			const hasRuby = (word.ruby?.length ?? 0) > 0;
			if (!hasRuby || word.rubyPhraseStart) {
				animatedWords.push(word);
			}
		}

		animatedWords.forEach((word, i) => {
			const wordEl = word.mainElement;
			if (!wordEl) return;

			const hasRuby = (word.ruby?.length ?? 0) > 0;
			const fadeWidth = word.height * this.lyricPlayer.getWordFadeWidth();

			// 取消之前的动画
			for (const a of word.maskAnimations) {
				a.cancel();
			}
			word.maskAnimations = [];

			if (hasRuby && word.rubyWordEl && word.wordBodyEl) {
				// 有 ruby 的情况：分别为 rubyWord 和 wordBody 创建动画
				this.createRubyWordAnimation(word, word.rubyWordEl, totalFadeDuration, fadeWidth, i);
				this.createWordBodyAnimation(word, word.wordBodyEl, totalFadeDuration, fadeWidth, i);
			} else if (word.wordBodyEl) {
				// 没有 ruby 但使用了 wordBody 结构（hasRubyLine 为 true 时）
				// 只为 wordBody 创建动画，不需要 rubyWord 动画
				this.createWordBodyAnimation(word, word.wordBodyEl, totalFadeDuration, fadeWidth, i);
			} else {
				// 没有 ruby 且没有 wordBody 的情况：为整个 word 创建动画
				this.createWordAnimation(word, wordEl, totalFadeDuration, fadeWidth, i);
			}
		});
	}

	/**
	 * 为 rubyWord 下的每个 span 创建动画
	 * 每个 span 负责单个 ruby 字符的动画
	 */
	private createRubyWordAnimation(
		word: RealWord,
		rubyWordEl: HTMLDivElement,
		totalFadeDuration: number,
		fadeWidth: number,
		index: number,
	) {
		// 获取所有 ruby span 元素
		const rubySpans = Array.from(rubyWordEl.children) as HTMLSpanElement[];
		if (rubySpans.length === 0) return;

		// 收集所有 ruby 字符的时间信息（包括当前单词和被合并的单词）
		// 使用数组保存 [rubySegment, parentWord] 对
		const allRubyData: { ruby: LyricWordBase; parentWord: LyricWord }[] = [];

		// 首先添加当前单词的 ruby
		const currentRubySegments = this.getRubySegments(word);
		for (const ruby of currentRubySegments) {
			allRubyData.push({ ruby, parentWord: word });
		}

		// 添加被合并单词的 ruby
		if (word.mergedWords) {
			for (const mergedWord of word.mergedWords) {
				const mergedRubySegments = this.getRubySegments(mergedWord);
				for (const ruby of mergedRubySegments) {
					allRubyData.push({ ruby, parentWord: mergedWord });
				}
			}
		}

		if (allRubyData.length === 0) return;

		// 收集所有 ruby 字符的时间信息
		const rubyChars: { startTime: number; endTime: number; element: HTMLSpanElement }[] = [];
		let spanIndex = 0;

		for (const { ruby, parentWord } of allRubyData) {
			// 使用 parentWord 的时间作为默认值，而不是 word（短语起始单词）的时间
			const rubyStartTime = Number.isFinite(ruby.startTime) ? ruby.startTime : parentWord.startTime;
			const rubyEndTime = Number.isFinite(ruby.endTime) ? ruby.endTime : parentWord.endTime;
			const rubyStart = Math.max(rubyStartTime, parentWord.startTime);
			const rubyEnd = Math.min(Math.max(rubyEndTime, rubyStart), parentWord.endTime);
			const rubyDuration = Math.max(0, rubyEnd - rubyStart);
			const perCharDuration = rubyDuration / ruby.word.length;

			for (let i = 0; i < ruby.word.length; i++) {
				if (spanIndex < rubySpans.length) {
					rubyChars.push({
						startTime: rubyStart + perCharDuration * i,
						endTime: rubyStart + perCharDuration * (i + 1),
						element: rubySpans[spanIndex],
					});
					spanIndex++;
				}
			}
		}

		// 为每个 ruby 字符的 span 创建动画
		for (let i = 0; i < rubyChars.length; i++) {
			const char = rubyChars[i];
			const charWidth = char.element.clientWidth || 0;

			const [maskImage, totalAspect] = generateFadeGradient(
				fadeWidth / Math.max(1, charWidth),
			);
			const totalAspectStr = `${totalAspect * 100}% 100%`;

			// 设置遮罩样式
			if (this.lyricPlayer.supportMaskImage) {
				char.element.style.maskImage = maskImage;
				char.element.style.maskRepeat = "no-repeat";
				char.element.style.maskOrigin = "left";
				char.element.style.maskSize = totalAspectStr;
			} else {
				char.element.style.webkitMaskImage = maskImage;
				char.element.style.webkitMaskRepeat = "no-repeat";
				char.element.style.webkitMaskOrigin = "left";
				char.element.style.webkitMaskSize = totalAspectStr;
			}

			const minOffset = -(charWidth + fadeWidth);
			const clampOffset = (x: number) => Math.max(minOffset, Math.min(0, x));

			// 生成动画帧
			const frames: Keyframe[] = [];
			const charStartStamp = char.startTime - this.lyricLine.startTime;
			const charEndStamp = char.endTime - this.lyricLine.startTime;

			// 初始状态（遮罩在左侧外）
			frames.push({
				offset: 0,
				maskPosition: `${clampOffset(-charWidth - fadeWidth)}px 0`,
			});

			// 开始时间前保持隐藏
			const startOffset = Math.max(0, charStartStamp / totalFadeDuration);
			if (startOffset > 0) {
				frames.push({
					offset: startOffset,
					maskPosition: `${clampOffset(-charWidth - fadeWidth)}px 0`,
				});
			}

			// 动画过程：从左侧外移动到完全显示
			const endOffset = Math.min(1, charEndStamp / totalFadeDuration);
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
				const ani = char.element.animate(frames, {
					duration: totalFadeDuration || 1,
					id: `fade-ruby-char-${char.element.innerText}-${index}-${i}`,
					fill: "both",
				});
				ani.pause();
				word.maskAnimations.push(ani);
			} catch (err) {
				console.warn("应用 ruby 字符渐变动画发生错误", frames, totalFadeDuration, err);
			}
		}
	}

	/**
	 * 为 wordBody 下的每个 span 创建动画
	 * 每个 span 负责单个 base 字符（或单词）的动画
	 */
	private createWordBodyAnimation(
		word: RealWord,
		wordBodyEl: HTMLDivElement,
		totalFadeDuration: number,
		fadeWidth: number,
		index: number,
	) {
		// 获取所有 wordBody 下的 span 元素
		const wordSpans = Array.from(wordBodyEl.children) as HTMLSpanElement[];
		if (wordSpans.length === 0) return;

		// 收集所有 base 单词的时间信息和对应的元素
		// 每个条目包含：原文 div 和 romanWord 内部的 span
		const baseWords: {
			word: string;
			startTime: number;
			endTime: number;
			baseTextEl: HTMLDivElement;
			romanWordSpan?: HTMLSpanElement;
		}[] = [];

		// 首先添加当前单词
		if (wordSpans.length > 0) {
			// 获取 span 内第一个 div（包裹原文的 div）
			const baseTextEl = wordSpans[0].querySelector("div:first-child") as HTMLDivElement;
			// 获取 romanWord 内部的 span（如果有）
			const romanWordSpan = wordSpans[0].querySelector(`.${styles.romanWord} > span`) as HTMLSpanElement | null;
			if (baseTextEl) {
				baseWords.push({
					word: word.word,
					startTime: word.startTime,
					endTime: word.endTime,
					baseTextEl,
					romanWordSpan: romanWordSpan || undefined,
				});
			}
		}

		// 添加被合并的单词（从 mergedWords 中获取）
		if (word.mergedWords && word.mergedWords.length > 0) {
			for (let i = 0; i < word.mergedWords.length && i + 1 < wordSpans.length; i++) {
				const mergedWord = word.mergedWords[i];
				// 获取 span 内第一个 div（包裹原文的 div）
				const baseTextEl = wordSpans[i + 1].querySelector("div:first-child") as HTMLDivElement;
				// 获取 romanWord 内部的 span（如果有）
				const romanWordSpan = wordSpans[i + 1].querySelector(`.${styles.romanWord} > span`) as HTMLSpanElement | null;
				if (baseTextEl) {
					baseWords.push({
						word: mergedWord.word,
						startTime: mergedWord.startTime,
						endTime: mergedWord.endTime,
						baseTextEl,
						romanWordSpan: romanWordSpan || undefined,
					});
				}
			}
		}

		// 为每个 base 单词的原文 div 和 romanWord 内部的 span 创建动画
		for (let i = 0; i < baseWords.length; i++) {
			const baseWord = baseWords[i];

			// 为原文 div 创建动画
			this.applyMaskAnimation(
				baseWord.baseTextEl,
				baseWord.startTime,
				baseWord.endTime,
				totalFadeDuration,
				fadeWidth,
				word,
				`fade-base-word-${baseWord.word}-${index}-${i}`,
			);

			// 为 romanWord 内部的 span 创建动画（如果存在）
			if (baseWord.romanWordSpan) {
				this.applyMaskAnimation(
					baseWord.romanWordSpan as unknown as HTMLDivElement,
					baseWord.startTime,
					baseWord.endTime,
					totalFadeDuration,
					fadeWidth,
					word,
					`fade-roman-word-${baseWord.word}-${index}-${i}`,
				);
			}
		}
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

		this.lineTransforms.posY.update(delta);
		this.lineTransforms.scale.update(delta);

		if (this.isInSight) {
			this.show();
		} else {
			this.hide();
		}

		const currentScale = this.lineTransforms.scale.getCurrentPosition() / 100;
		this.updateMaskAlphaTargets(currentScale);
		this.applyAlphaToDom(delta);
	}

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
