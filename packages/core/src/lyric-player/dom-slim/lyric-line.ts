import bezier from "bezier-easing";
import type { LyricLine, LyricWord } from "../../interfaces.ts";
import { chunkAndSplitLyricWords } from "../../utils/lyric-split-words.ts";
import {
	createMatrix4,
	matrix4ToCSS,
	scaleMatrix4,
} from "../../utils/matrix.ts";
import { mutexifyFunction } from "../../utils/mutex.ts";
import { measure, mutate } from "../../utils/schedule.ts";
import { LyricLineBase } from "../base.ts";
import styles from "./index.module.css";
import type { DomSlimLyricPlayer } from "./index.ts";

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

/**
 * 动画段：同一视觉行内、连续无空格的音节组
 */
interface AnimationSegment {
	/** 包含的单词 */
	words: RealWord[];
	/** 所在视觉行索引 */
	lineIndex: number;
	/** 行内起始 X 偏移 */
	offsetLeft: number;
	/** 容器总宽度 */
	totalWidth: number;
	/** 容器高度 */
	height: number;
	/** 开始时间 */
	startTime: number;
	/** 结束时间 */
	endTime: number;
	/** 动画容器元素 */
	containerElement: HTMLSpanElement | null;
	/** 遮罩动画 */
	maskAnimation: Animation | null;
	/** 每个单词的宽度缓存 */
	wordWidths: number[];
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
		public readonly line: LyricLineEl,
		event: MouseEvent,
	) {
		super(event.type, event);
	}
}

function getScaleFromTransform(transform: string): number {
	const match = transform.match(/matrix\(([^)]+)\)/);
	if (match) {
		const values = match[1].split(", ");
		const scaleX = Number.parseFloat(values[0]);
		const scaleY = Number.parseFloat(values[3]);
		return (scaleX + scaleY) / 2; // Average of scaleX and scaleY
	}
	return 1; // Default scale value if not found
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
	/** 动画段列表 */
	private animationSegments: AnimationSegment[] = [];
	// 由 LyricPlayer 来设置
	lineSize: number[] = [0, 0];

	constructor(
		private lyricPlayer: DomSlimLyricPlayer,
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
		this.element.setAttribute("class", styles.lyricLine);
		if (this.lyricLine.isBG) {
			this.element.classList.add(styles.lyricBgLine);
		}
		if (this.lyricLine.isDuet) {
			this.element.classList.add(styles.lyricDuetLine);
		}
		if (this.lyricLine.isRtl) {
			this.element.classList.add(styles.lyricRtlLine);
		}
		this.element.appendChild(document.createElement("div")); // 歌词行
		this.element.appendChild(document.createElement("div")); // 翻译行
		this.element.appendChild(document.createElement("div")); // 音译行
		const main = this.element.children[0] as HTMLDivElement;
		const trans = this.element.children[1] as HTMLDivElement;
		const roman = this.element.children[2] as HTMLDivElement;
		main.setAttribute("class", styles.lyricMainLine);
		trans.setAttribute(
			"class",
			`${styles.lyricSubLine} ${styles.lyricTransLine}`,
		);
		roman.setAttribute(
			"class",
			`${styles.lyricSubLine} ${styles.lyricRomanLine}`,
		);
		this.rebuildElement();
		this.rebuildStyle();
		this.markMaskImageDirty("Initial construction");
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

	/**
	 * 获取所有视觉行信息
	 */
	private getVisualLines(): { index: number; top: number; height: number }[] {
		const lines: Map<number, { top: number; height: number }> = new Map();

		for (const word of this.splittedWords) {
			const rects = word.mainElement.getClientRects();
			for (const rect of rects) {
				// 查找是否已有相近的行
				let found = false;
				for (const [, line] of lines) {
					if (Math.abs(line.top - rect.top) < 3) {
						found = true;
						break;
					}
				}
				if (!found) {
					lines.set(rect.top, { top: rect.top, height: rect.height });
				}
			}
		}

		// 按 top 排序并分配索引
		return Array.from(lines.values())
			.sort((a, b) => a.top - b.top)
			.map((line, index) => ({ ...line, index }));
	}

	/**
	 * 将单词分组为动画段
	 * 规则：同一视觉行内、以空格分隔的连续音节
	 */
	private groupWordsIntoSegments(): AnimationSegment[] {
		const segments: AnimationSegment[] = [];

		// 获取视觉行
		const visualLines = this.getVisualLines();

		// 按视觉行分组单词
		const wordsByLine: RealWord[][] = Array(visualLines.length)
			.fill(null)
			.map(() => []);

		for (const word of this.splittedWords) {
			const rects = word.mainElement.getClientRects();
			for (const rect of rects) {
				const lineIndex = visualLines.findIndex(
					(l) => Math.abs(l.top - rect.top) < 3,
				);
				if (lineIndex >= 0 && !wordsByLine[lineIndex].includes(word)) {
					wordsByLine[lineIndex].push(word);
				}
			}
		}

		// 每行内按原始顺序排序并按空格分割
		for (let i = 0; i < wordsByLine.length; i++) {
			const lineWords = wordsByLine[i];
			lineWords.sort((a, b) => {
				const idxA = this.splittedWords.indexOf(a);
				const idxB = this.splittedWords.indexOf(b);
				return idxA - idxB;
			});

			// 按空格分割成段
			let currentGroup: RealWord[] = [];
			for (let j = 0; j < lineWords.length; j++) {
				const word = lineWords[j];
				currentGroup.push(word);

				// 检查是否需要分割（单词末尾有空格或下一个是空格）
				const hasTrailingSpace = word.word.endsWith(' ');
				const nextWord = lineWords[j + 1];
				const nextHasLeadingSpace = nextWord?.word.startsWith(' ');

				if (hasTrailingSpace || nextHasLeadingSpace || !nextWord) {
					if (currentGroup.length > 0) {
						segments.push({
							words: [...currentGroup],
							lineIndex: i,
							offsetLeft: 0,
							totalWidth: 0,
							height: 0,
							startTime: currentGroup[0].startTime,
							endTime: currentGroup[currentGroup.length - 1].endTime,
							containerElement: null,
							maskAnimation: null,
							wordWidths: [],
						});
						currentGroup = [];
					}
				}
			}
		}

		return segments;
	}

	/**
	 * 为动画段创建容器元素并插入 DOM
	 */
	private createSegmentContainers(segments: AnimationSegment[]): void {
		const main = this.element.children[0] as HTMLDivElement;

		for (const segment of segments) {
			// 创建容器
			const container = document.createElement('span');
			container.classList.add(styles.animationSegment);

			// 合并文本
			const text = segment.words.map(w => w.word.trim()).join('');
			container.textContent = text;

			// 设置初始样式（用于测量）
			container.style.cssText = `
				position: absolute;
				white-space: nowrap;
				visibility: hidden;
			`;

			// 临时插入 DOM 进行测量
			main.appendChild(container);
			segment.containerElement = container;
		}
	}

	/**
	 * 测量动画段并更新位置信息
	 */
	private measureSegments(segments: AnimationSegment[]): void {
		const mainRect = this.element.getBoundingClientRect();

		for (const segment of segments) {
			if (!segment.containerElement) continue;

			const rect = segment.containerElement.getBoundingClientRect();
			segment.offsetLeft = rect.left - mainRect.left;
			segment.totalWidth = rect.width;
			segment.height = rect.height;

			// 测量每个单词的宽度
			segment.wordWidths = segment.words.map(word => {
				const wordRect = word.mainElement.getBoundingClientRect();
				return wordRect.width;
			});
		}
	}

	/**
	 * 为动画段创建遮罩动画
	 */
	private createSegmentMaskAnimations(segments: AnimationSegment[]): void {
		for (const segment of segments) {
			if (!segment.containerElement) continue;

			const { totalWidth, height, words } = segment;
			if (totalWidth === 0 || words.length === 0) continue;

			// 设置遮罩样式
			const fadeWidth = height * this.lyricPlayer.getWordFadeWidth();
			const [maskImage, totalAspect] = generateFadeGradient(
				fadeWidth / totalWidth,
			);

			const container = segment.containerElement;
			container.style.maskImage = maskImage;
			container.style.maskRepeat = 'no-repeat';
			container.style.maskOrigin = 'left';
			container.style.maskSize = `${totalAspect * 100}% 100%`;
			container.style.visibility = 'visible';
			container.style.position = 'absolute';
			container.style.left = `${segment.offsetLeft}px`;

			// 生成分段关键帧
			const frames = this.buildSegmentKeyframes(segment, fadeWidth);

			// 创建动画
			const animation = container.animate(frames, {
				duration: this.totalDuration || 1,
				id: `fade-segment-${segment.lineIndex}-${segment.startTime}`,
				fill: 'both',
			});
			animation.pause();

			segment.maskAnimation = animation;
		}
	}

	/**
	 * 构建分段关键帧
	 * 每个音节对应一个动画阶段，遮罩平移距离按真实宽度比例分配
	 */
	private buildSegmentKeyframes(
		segment: AnimationSegment,
		fadeWidth: number,
	): Keyframe[] {
		const frames: Keyframe[] = [];
		const totalDuration = this.totalDuration;
		const { words, wordWidths, totalWidth } = segment;

		// 计算每个音节对应的遮罩位置
		let accumulatedWidth = 0;
		const positions = words.map((word, i) => {
			const width = wordWidths[i] || 0;
			const startPos = -(totalWidth - accumulatedWidth + fadeWidth);
			accumulatedWidth += width;
			const endPos = -(totalWidth - accumulatedWidth + fadeWidth);
			return { word, startPos, endPos };
		});

		// 生成关键帧
		for (let i = 0; i < positions.length; i++) {
			const { word, startPos, endPos } = positions[i];
			const isLast = i === positions.length - 1;

			// 音节开始时间
			const wordStartOffset = (word.startTime - this.lyricLine.startTime) / totalDuration;
			// 音节结束时间
			const wordEndOffset = (word.endTime - this.lyricLine.startTime) / totalDuration;

			// 阶段开始：遮罩在该音节起始位置
			frames.push({
				offset: Math.max(0, wordStartOffset),
				maskPosition: `${startPos}px 0`,
			});

			// 阶段结束：遮罩移动到该音节结束位置
			// 最后一个音节需要完全移出（显示全部）
			const finalPos = isLast ? fadeWidth * 0.5 : endPos;
			frames.push({
				offset: Math.min(1, wordEndOffset),
				maskPosition: `${finalPos}px 0`,
			});
		}

		return frames;
	}

	/**
	 * 清理动画段
	 */
	private clearAnimationSegments(): void {
		for (const segment of this.animationSegments) {
			if (segment.maskAnimation) {
				segment.maskAnimation.cancel();
			}
			if (segment.containerElement?.parentNode) {
				segment.containerElement.parentNode.removeChild(segment.containerElement);
			}
		}
		this.animationSegments = [];
	}

	private isEnabled = false;
	async enable(maskAnimationTime = this.lyricLine.startTime) {
		this.isEnabled = true;
		this.element.classList.add(styles.active);
		await this.waitMaskImageUpdated();
		const main = this.element.children[0] as HTMLDivElement;
		
		// 控制元素动画（强调效果等）
		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				a.currentTime = 0;
				a.playbackRate = 1;
				a.play();
			}
		}
		
		// 控制分段遮罩动画
		for (const segment of this.animationSegments) {
			if (segment.maskAnimation) {
				segment.maskAnimation.currentTime = Math.min(
					this.totalDuration,
					Math.max(0, maskAnimationTime - this.lyricLine.startTime),
				);
				segment.maskAnimation.playbackRate = 1;
				segment.maskAnimation.play();
			}
		}
		
		main.classList.add(styles.active);
	}
	disable() {
		this.isEnabled = false;
		this.element.classList.remove(styles.active);
		const main = this.element.children[0] as HTMLDivElement;
		
		// 控制元素动画
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
		}
		
		main.classList.remove(styles.active);
	}
	private lastWord?: RealWord;
	async resume() {
		await this.waitMaskImageUpdated();
		if (!this.isEnabled) return;
		
		// 控制元素动画
		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				if (
					!this.lastWord ||
					this.splittedWords.indexOf(this.lastWord) <
						this.splittedWords.indexOf(word)
				) {
					a.play();
				}
			}
		}
		
		// 控制分段遮罩动画
		for (const segment of this.animationSegments) {
			if (segment.maskAnimation) {
				// 检查该段是否在当前单词之后
				const segmentStartWord = segment.words[0];
				if (
					!this.lastWord ||
					this.splittedWords.indexOf(this.lastWord) <
						this.splittedWords.indexOf(segmentStartWord)
				) {
					segment.maskAnimation.play();
				}
			}
		}
	}
	async pause() {
		await this.waitMaskImageUpdated();
		if (!this.isEnabled) return;
		
		// 暂停元素动画
		for (const word of this.splittedWords) {
			for (const a of word.elementAnimations) {
				a.pause();
			}
		}
		
		// 暂停分段遮罩动画
		for (const segment of this.animationSegments) {
			if (segment.maskAnimation) {
				segment.maskAnimation.pause();
			}
		}
	}
	setMaskAnimationState(maskAnimationTime = 0) {
		const t = maskAnimationTime - this.lyricLine.startTime;
		
		// 设置分段遮罩动画状态
		for (const segment of this.animationSegments) {
			if (segment.maskAnimation) {
				segment.maskAnimation.currentTime = Math.min(this.totalDuration, Math.max(0, t));
				segment.maskAnimation.playbackRate = 1;
				if (t >= 0 && t < this.totalDuration) {
					segment.maskAnimation.play();
				} else {
					segment.maskAnimation.pause();
				}
			}
		}
	}
	private measureLockMark = false;
	private measureLock = mutexifyFunction(
		async (callback: () => Promise<void>): Promise<void> => {
			if (this.measureLockMark) return;
			this.measureLockMark = true;
			// if (this._hide) {
			// 	await mutate(() => {
			// 		this._prevParentEl.appendChild(this.element);
			// 		this.element.style.display = "";
			// 		this.element.style.visibility = "hidden";
			// 	});
			// }
			await callback();
			// if (this._hide) {
			// 	await mutate(() => {
			// 		this._prevParentEl.removeChild(this.element);
			// 		this.element.style.display = "none";
			// 		this.element.style.visibility = "";
			// 	});
			// }
			this.measureLockMark = false;
		},
	);

	getLine() {
		return this.lyricLine;
	}
	show() {
		// this._hide = false;
		// if (!this.measureLockMark && !this.element.parentElement) {
		// 	this._prevParentEl.appendChild(this.element);
		// }
		this.rebuildStyle();
	}
	hide() {
		// this._hide = true;
		// if (!this.measureLockMark && this.element.parentElement) {
		// 	this._prevParentEl.removeChild(this.element);
		// }
	}
	private rebuildStyle() {
		// let style = "";
		// if (!this.lyricPlayer.getEnableSpring() && this.isInSight) {
		// 	style += `transition-delay:${this.delay}ms;`;
		// }
		// style += `filter:blur(${Math.min(32, this.blur)}px);`;
		// if (style !== this.lastStyle) {
		// 	this.lastStyle = style;
		// 	this.element.setAttribute("style", style);
		// }
	}

	private getRubySegments(word: LyricWord) {
		return (word.ruby ?? []).filter(
			(ruby) => (ruby?.word?.trim().length ?? 0) > 0,
		);
	}

	private buildWordElement(
		word: LyricWord,
		shouldEmphasize: boolean,
		hasRubyLine: boolean,
		hasRomanLine: boolean,
		displayWord: string,
	) {
		const mainWordEl = document.createElement("span");
		const subElements: HTMLSpanElement[] = [];
		const romanWord = word.romanWord?.trim() ?? "";
		let wordContainer: HTMLElement = mainWordEl;
		if (hasRubyLine || hasRomanLine) {
			wordContainer = document.createElement("div");
			mainWordEl.appendChild(wordContainer);
		}
		if (hasRubyLine) {
			const rubyWordEl = document.createElement("div");
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
			mainWordEl.insertBefore(rubyWordEl, wordContainer);
		}

		if (shouldEmphasize) {
			mainWordEl.classList.add(styles.emphasize);
			for (const char of displayWord.trim()) {
				const charEl = document.createElement("span");
				charEl.innerText = char;
				subElements.push(charEl);
				wordContainer.appendChild(charEl);
			}
		} else if (hasRomanLine) {
			const wordEl = document.createElement("div");
			wordEl.innerText = displayWord;
			wordContainer.appendChild(wordEl);
		} else {
			mainWordEl.innerText = displayWord;
		}

		if (hasRomanLine) {
			const romanWordEl = document.createElement("div");
			romanWordEl.classList.add(styles.romanWord);
			// 嵌套一层 span 放置文本内容
			const romanTextSpan = document.createElement("span");
			romanTextSpan.innerText = romanWord.length > 0 ? romanWord : "\u00A0";
			romanWordEl.appendChild(romanTextSpan);
			wordContainer.appendChild(romanWordEl);
		}

		return { mainWordEl, subElements };
	}
	override rebuildElement() {
		this.disposeElements();
		const main = this.element.children[0] as HTMLDivElement;
		const trans = this.element.children[1] as HTMLDivElement;
		const roman = this.element.children[2] as HTMLDivElement;
		// 如果是非动态歌词，那么就不需要分词了
		if (this.lyricPlayer._getIsNonDynamic()) {
			main.innerText = this.lyricLine.words.map((w) => w.word).join("");
			trans.innerText = this.lyricLine.translatedLyric;
			roman.innerText = this.lyricLine.romanLyric;
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
			if (Array.isArray(chunk)) {
				// 多个没有空格的单词组合成的一个单词数组
				if (chunk.length === 0) continue;
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
				const emp = chunk
					.map((word) => LyricLineBase.shouldEmphasize(word))
					.reduce((a, b) => a || b, LyricLineBase.shouldEmphasize(merged));
				
				// 创建禁止换行容器
				const noBreakWrapper = document.createElement("span");
				noBreakWrapper.classList.add(styles.noBreakWrapper);
				
				const wrapperWordEl = document.createElement("span");
				wrapperWordEl.classList.add(styles.emphasizeWrapper);
				const characterElements: HTMLElement[] = [];
				for (const word of chunk) {
					const { mainWordEl, subElements } = this.buildWordElement(
						word,
						emp,
						hasRubyLine,
						hasRomanLine,
						word.word,
					);
					if (emp) {
						characterElements.push(...subElements);
					}
					this.splittedWords.push({
						...word,
						mainElement: mainWordEl,
						subElements: subElements,
						// elementAnimations: [this.initFloatAnimation(word, mainWordEl)],
						elementAnimations: [], // this.initFloatAnimation(word, mainWordEl)
						maskAnimations: [],
						width: 0,
						height: 0,
						padding: 0,
						shouldEmphasize: emp,
					});
					wrapperWordEl.appendChild(mainWordEl);
				}
				if (emp) {
					this.splittedWords[
						this.splittedWords.length - 1
					].elementAnimations.push(
						...this.initEmphasizeAnimation(
							merged,
							characterElements,
							merged.endTime - merged.startTime,
							merged.startTime - this.lyricLine.startTime,
						),
					);
				}

				// 将 emphasizeWrapper 放入 noBreakWrapper
				noBreakWrapper.appendChild(wrapperWordEl);

				if (merged.word.trimStart() !== merged.word) {
					main.appendChild(document.createTextNode(" "));
				}
				main.appendChild(noBreakWrapper);
				if (
					merged.word.trimEnd() !== merged.word &&
					LyricLineBase.shouldEmphasize(merged)
				) {
					main.appendChild(document.createTextNode(" "));
				}
			} else if (chunk.word.trim().length === 0) {
				// 纯空格
				main.appendChild(document.createTextNode(" "));
			} else {
				// 单个单词
				const emp = LyricLineBase.shouldEmphasize(chunk);
				const { mainWordEl, subElements } = this.buildWordElement(
					chunk,
					emp,
					hasRubyLine,
					hasRomanLine,
					chunk.word.trim(),
				);
				const realWord: RealWord = {
					...chunk,
					mainElement: mainWordEl,
					subElements: subElements,
					// elementAnimations: [this.initFloatAnimation(chunk, mainWordEl)],
					elementAnimations: [], // this.initFloatAnimation(chunk, mainWordEl)
					maskAnimations: [],
					width: 0,
					height: 0,
					padding: 0,
					shouldEmphasize: emp,
				};
				if (emp) {
					const duration = Math.abs(realWord.endTime - realWord.startTime);
					realWord.elementAnimations.push(
						...this.initEmphasizeAnimation(
							chunk,
							subElements,
							duration,
							realWord.startTime - this.lyricLine.startTime,
						),
					);
				}
				if (chunk.word.trimStart() !== chunk.word) {
					main.appendChild(document.createTextNode(" "));
				}
				main.appendChild(mainWordEl);
				if (chunk.word.trimEnd() !== chunk.word) {
					main.appendChild(document.createTextNode(" "));
				}
				this.splittedWords.push(realWord);
			}
		}
		trans.innerText = this.lyricLine.translatedLyric;
		roman.innerText = this.lyricLine.romanLyric;
	}
	// 按照原 Apple Music 参考，强调效果只应用缩放、轻微左右位移和辉光效果，原主要的悬浮位移效果不变
	// 为了避免产生锯齿抖动感，使用 matrix3d 来实现缩放和位移
	private initEmphasizeAnimation(
		word: LyricWord,
		characterElements: HTMLElement[],
		duration: number,
		delay: number,
	): Animation[] {
		const de = Math.max(0, delay);
		let du = Math.max(1000, duration);

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
			const wordDe = de + (du / 2.5 / arr.length) * i;
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
	private maskImageDirty = false;
	private markImageDirtyPromiseResolve: Set<() => void> = new Set();
	private markImageDirtyPromise: Promise<void> = new Promise((resolve) => {
		this.markImageDirtyPromiseResolve.add(resolve);
	});
	markMaskImageDirty(_debugReason = ""): Promise<void> {
		this.maskImageDirty = true;
		if (!this.element.classList.contains(styles.dirty))
			this.element.classList.add(styles.dirty);
		// if (import.meta.env.DEV) {
		// 	console.log("Mark mask image dirty: ", _debugReason);
		// }
		const newPromise = Promise.all([
			this.markImageDirtyPromise,
			new Promise<void>((resolve) => {
				this.markImageDirtyPromiseResolve.add(resolve);
			}),
		]).then(() => {});
		this.markImageDirtyPromise = newPromise;
		return newPromise;
	}
	waitMaskImageUpdated(): Promise<void> {
		return this.markImageDirtyPromise;
	}
	async updateMaskImage() {
		if (
			!this.element.checkVisibility({
				contentVisibilityAuto: true,
			})
		)
			return;
		this.maskImageDirty = false;
		await this.measureLock(async () => {
			// 清理旧的分段动画
			this.clearAnimationSegments();

			// 分组并创建容器
			const segments = this.groupWordsIntoSegments();
			
			await mutate(() => {
				this.createSegmentContainers(segments);
			});

			// 测量
			await measure(() => {
				this.measureSegments(segments);
			});

			// 创建动画
			await mutate(() => {
				this.createSegmentMaskAnimations(segments);
				this.animationSegments = segments;
			});
		});

		for (const resolve of this.markImageDirtyPromiseResolve) {
			resolve();
			this.markImageDirtyPromiseResolve.delete(resolve);
		}
		await mutate(() => {
			this.element.classList.remove(styles.dirty);
		});
	}
	getElement() {
		return this.element;
	}
	override setTransform(
		top: number = this.top,
		scale: number = this.scale,
		opacity = 1,
		blur = 0,
		force = false,
		delay = 0,
	) {
		super.setTransform(top, scale, opacity, blur, force, delay);
		const beforeInSight = this.isInSight;
		const enableSpring = this.lyricPlayer.getEnableSpring();
		this.top = top;
		this.scale = scale;
		this.delay = (delay * 1000) | 0;
		const main = this.element.children[0] as HTMLDivElement;
		// main.style.opacity = `${opacity *
		// 	(!this.hasFaded ? 1 : this.lyricPlayer._getIsNonDynamic() ? 1 : 0.3)
		// 	}`;
		main.style.opacity = `${opacity}`;
		// trans.style.opacity = `${subopacity}`;
		// roman.style.opacity = `${subopacity}`;
		if (force || !enableSpring) {
			if (force) this.element.classList.add(styles.tmpDisableTransition);
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
			if (force)
				requestAnimationFrame(() => {
					this.element.classList.remove(styles.tmpDisableTransition);
				});
		} else {
			// this.lineWebAnimationTransforms.posX.stop();
			// this.lineWebAnimationTransforms.posY.stop();
			// this.lineWebAnimationTransforms.scale.stop();
			this.lineTransforms.posY.setTargetPosition(top, delay);
			this.lineTransforms.scale.setTargetPosition(scale);
		}
	}
	update(delta = 0) {
		if (!this.lyricPlayer.getEnableSpring()) return;
		this.lineTransforms.posY.update(delta);
		this.lineTransforms.scale.update(delta);
		if (this.isInSight) {
			this.show();
			if (this.maskImageDirty) {
				this.updateMaskImage();
			}
		} else {
			this.hide();
		}
		if (this.lyricPlayer.getEnableSpring()) {
			this.element.style.setProperty(
				"--bright-mask-alpha",
				`${
					Math.max(
						0.0,
						Math.min(
							1.0,
							this.lineTransforms.scale.getCurrentPosition() / 100 - 0.97,
						) / 0.03,
					) *
						0.8 +
					0.2
				}`,
			);
			this.element.style.setProperty(
				"--dark-mask-alpha",
				`${
					Math.max(
						0.0,
						Math.min(
							1.0,
							this.lineTransforms.scale.getCurrentPosition() / 100 - 0.97,
						) / 0.03,
					) *
						0.2 +
					0.2
				}`,
			);
		} else {
			const computedStyle = window.getComputedStyle(this.element);
			const transform = computedStyle.transform;

			// Extract the scale value from the transform property
			const scale = getScaleFromTransform(transform);

			this.element.style.setProperty(
				"--bright-mask-alpha",
				`${Math.max(0.0, Math.min(1.0, (scale - 0.97) / 0.03)) * 0.8 + 0.2}`,
			);
			this.element.style.setProperty(
				"--dark-mask-alpha",
				`${Math.max(0.0, Math.min(1.0, (scale - 0.97) / 0.03)) * 0.2 + 0.2}`,
			);
		}
	}

	_getDebugTargetPos(): string {
		return `[位移: ${this.top}; 缩放: ${this.scale}; 延时: ${this.delay}]`;
	}

	get isInSight() {
		const t = this.lineTransforms.posY.getCurrentPosition();
		const h = this.lineSize[1];
		const b = t + h;
		const pb = this.lyricPlayer.size[1];
		return !(t > pb + h || b < -h);
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
			realWord.mainElement.remove();
			realWord.mainElement.parentNode?.removeChild(realWord.mainElement);
		}
		this.splittedWords = [];
	}
	override dispose(): void {
		this.disposeElements();
		this.element.remove();
	}
}
