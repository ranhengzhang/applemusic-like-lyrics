/**
 * @fileoverview
 * 一个播放歌词的组件
 * @author SteveXMH
 */

import structuredClone from "@ungap/structured-clone";
import type { Disposable, HasElement, LyricLine } from "../../interfaces";
import "../../styles/index.css";
import styles from "../../styles/lyric-player.module.css";
import { debounceFrame } from "../../utils/debounce";
import { eqSet } from "../../utils/eq-set";
import type { SpringParams } from "../../utils/spring";
import { BottomLineEl } from "../bottom-line";
import { InterludeDots } from "./interlude-dots";
import { LyricLineEl, type RawLyricLineMouseEvent } from "./lyric-line";

/**
 * 歌词行鼠标相关事件，可以获取到歌词行的索引和歌词行元素
 */
export class LyricLineMouseEvent extends MouseEvent {
	constructor(
		/**
		 * 歌词行索引
		 */
		public readonly lineIndex: number,
		/**
		 * 歌词行元素
		 */
		public readonly line: LyricLineEl,
		event: MouseEvent,
	) {
		super(`line-${event.type}`, event);
	}
}

export type LyricLineMouseEventListener = (evt: LyricLineMouseEvent) => void;

/**
 * 歌词播放组件，本框架的核心组件
 *
 * 尽可能贴切 Apple Music for iPad 的歌词效果设计，且做了力所能及的优化措施
 */
export class DomLyricPlayer
	extends EventTarget
	implements HasElement, Disposable
{
	private element: HTMLElement = document.createElement("div");
	private currentTime = 0;
	private lastCurrentTime = 0;
	private lyricLines: LyricLine[] = [];
	private processedLines: LyricLine[] = [];
	private lyricLinesEl: LyricLineEl[] = [];
	private lyricLinesSize: WeakMap<LyricLineEl, [number, number]> =
		new WeakMap();
	private lyricLinesIndexes: WeakMap<LyricLineEl, number> = new WeakMap();
	private hotLines: Set<number> = new Set();
	private bufferedLines: Set<number> = new Set();
	private scrollToIndex = 0;
	private _wordFadeWidth = 0.5;
	private allowScroll = true;
	private scrolledHandler = 0;
	private isScrolled = false;
	private isSeeking = false;
	private initializeSeeking = false;
	private invokedByScrollEvent = false;
	private scrollOffset = 0;
	private hidePassedLines = false;
	private debounceCalcLayout = debounceFrame(async () => {
		this.calcLayout(true, true);
		this.lyricLinesEl.forEach((el, i) => {
			el.markMaskImageDirty().then(() => {
				if (this.hotLines.has(i)) {
					el.enable(this.currentTime);
				}
			});
		});
	}, 5);
	private resizeObserver: ResizeObserver = new ResizeObserver(
		debounceFrame(
			((e) => {
				const rect = e[0].contentRect;
				this.size[0] = rect.width;
				this.size[1] = rect.height;
				const styles = getComputedStyle(e[0].target);
				const innerWidth =
					this.element.clientWidth -
					Number.parseFloat(styles.paddingLeft) -
					Number.parseFloat(styles.paddingRight);
				const innerHeight =
					this.element.clientHeight -
					Number.parseFloat(styles.paddingTop) -
					Number.parseFloat(styles.paddingBottom);
				this.innerSize[0] = innerWidth;
				this.innerSize[1] = innerHeight;
				this.rebuildStyle();
				this.lyricLinesEl.forEach((el, i) => {
					el.markMaskImageDirty().then(() => {
						if (this.hotLines.has(i)) {
							el.enable(this.currentTime);
						}
					});
				});
				for (const el of this.lyricLinesEl) {
					el.markMaskImageDirty();
				}
				this.debounceCalcLayout();
			}) as ResizeObserverCallback,
			5,
		),
	);
	private posXSpringParams: Partial<SpringParams> = {
		mass: 1,
		damping: 10,
		stiffness: 100,
	};
	private posYSpringParams: Partial<SpringParams> = {
		mass: 0.9,
		damping: 15,
		stiffness: 90,
	};
	private scaleSpringParams: Partial<SpringParams> = {
		mass: 2,
		damping: 25,
		stiffness: 100,
	};
	// private scaleSpringParams: Partial<SpringParams> = {
	// 	mass: 1,
	// 	damping: 25,
	// 	stiffness: 40,
	// };
	private scaleForBGSpringParams: Partial<SpringParams> = {
		mass: 1,
		damping: 20,
		stiffness: 50,
	};
	private enableBlur = true;
	private enableScale = true;
	private interludeDots: InterludeDots;
	private interludeDotsSize: [number, number] = [0, 0];
	private bottomLine: BottomLineEl;
	readonly supportPlusLighter = CSS.supports("mix-blend-mode", "plus-lighter");
	readonly supportMaskImage = CSS.supports("mask-image", "none");
	private disableSpring = false;
	private alignAnchor: "top" | "bottom" | "center" = "center";
	private alignPosition = 0.35;
	private isNonDynamic = false;
	private isNonDuet = false;
	private scrollBoundary = [0, 0];
	readonly size: [number, number] = [0, 0];
	readonly innerSize: [number, number] = [0, 0];
	private readonly onLineClickedHandler = (e: RawLyricLineMouseEvent) => {
		const evt = new LyricLineMouseEvent(
			this.lyricLinesIndexes.get(e.line) ?? -1,
			e.line,
			e,
		);
		if (!this.dispatchEvent(evt)) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
		}
	};
	/**
	 * 是否为非逐词歌词
	 * @internal
	 */
	_getIsNonDynamic() {
		return this.isNonDynamic;
	}
	setIsSeeking(isSeeking: boolean) {
		this.isSeeking = isSeeking;
	}
	/**
	 * 设置是否使用物理弹簧算法实现歌词动画效果，默认启用
	 *
	 * 如果启用，则会通过弹簧算法实时处理歌词位置，但是需要性能足够强劲的电脑方可流畅运行
	 *
	 * 如果不启用，则会回退到基于 `transition` 的过渡效果，对低性能的机器比较友好，但是效果会比较单一
	 */
	setEnableSpring(enable = true) {
		this.disableSpring = !enable;
		if (enable) {
			this.element.classList.remove(styles.disableSpring);
		} else {
			this.element.classList.add(styles.disableSpring);
		}
		this.calcLayout(true);
	}
	/**
	 * 获取当前是否启用了物理弹簧
	 * @returns 是否启用物理弹簧
	 */
	getEnableSpring() {
		return !this.disableSpring;
	}
	/**
	 * 是否启用歌词行缩放效果，默认启用
	 *
	 * 如果启用，非选中的歌词行会轻微缩小以凸显当前播放歌词行效果
	 *
	 * 此效果对性能影响微乎其微，推荐启用
	 * @param enable 是否启用歌词行缩放效果
	 */
	setEnableScale(enable = true) {
		this.enableScale = enable;
		this.calcLayout();
	}
	/**
	 * 获取当前是否启用了歌词行缩放效果
	 * @returns 是否启用歌词行缩放效果
	 */
	getEnableScale() {
		return this.enableScale;
	}
	private _baseFontSize = Number.parseFloat(
		getComputedStyle(this.element).fontSize,
	);
	public get baseFontSize() {
		return this._baseFontSize;
	}
	private isPageVisible = true;
	private onPageShow = () => {
		this.isPageVisible = true;
		this.setCurrentTime(this.currentTime, true);
	};
	private onPageHide = () => {
		this.isPageVisible = false;
	};
	constructor() {
		super();
		this.interludeDots = new InterludeDots();
		this.bottomLine = new BottomLineEl(this);
		this.element.classList.add("amll-lyric-player", "dom");
		if (this.disableSpring) {
			this.element.classList.add(styles.disableSpring);
		}
		this.rebuildStyle();
		this.resizeObserver.observe(this.element);
		this.element.appendChild(this.interludeDots.getElement());
		this.element.appendChild(this.bottomLine.getElement());
		this.interludeDots.setTransform(0, 200);
		window.addEventListener("pageshow", this.onPageShow);
		window.addEventListener("pagehide", this.onPageHide);
		let startScrollY = 0;
		let direction: "up" | "down" | "none" = "none";
		let startTouchPosY = 0;
		let startScrollTime = 0;
		let scrollSpeed = 0;
		let scrollId = Symbol("amll-scroll");
		let lastMoveY = 0;
		let lastDragTime = 0;
		this.element.addEventListener("touchstart", (evt) => {
			if (this.beginScrollHandler()) {
				evt.preventDefault();
				startScrollY = this.scrollOffset;
				startTouchPosY = evt.touches[0].screenY;
				lastMoveY = startTouchPosY;
				startScrollTime = Date.now();
				scrollSpeed = 0;
			}
		});
		this.element.addEventListener("touchmove", (evt) => {
			if (this.beginScrollHandler()) {
				evt.preventDefault();
				const touchScreenY = evt.touches[0].screenY;
				const delta = touchScreenY - startTouchPosY;
				const lastDelta = touchScreenY - lastMoveY;
				const targetDirection =
					lastDelta > 0 ? "down" : lastDelta < 0 ? "up" : "none";
				if (direction !== targetDirection) {
					direction = targetDirection;
					startScrollY = this.scrollOffset;
					startTouchPosY = touchScreenY;
					startScrollTime = Date.now();
				} else {
					this.scrollOffset = startScrollY - delta;
				}
				lastMoveY = touchScreenY;
				lastDragTime = Date.now();
				this.limitScrollOffset();
				this.calcLayout(true);
			}
		});
		this.element.addEventListener("touchend", (evt) => {
			if (this.beginScrollHandler()) {
				evt.preventDefault();
				startTouchPosY = 0;
				const curTime = Date.now();
				if (curTime - lastDragTime > 100) return this.endScrollHandler();
				const scrollDuration = curTime - startScrollTime;
				scrollSpeed =
					((this.scrollOffset - startScrollY) / scrollDuration) * 1000;
				let lt = 0;
				const curScrollId = Symbol("amll-scroll");
				scrollId = curScrollId;
				const onScrollFrame = (dt: number) => {
					lt ||= dt;
					if (scrollId === curScrollId && this.beginScrollHandler()) {
						this.scrollOffset += (scrollSpeed * (dt - lt)) / 1000;
						scrollSpeed *= 0.99;
						this.limitScrollOffset();
						this.calcLayout(true);
						if (
							Math.abs(scrollSpeed) > 1 &&
							!this.scrollBoundary.includes(this.scrollOffset)
						) {
							requestAnimationFrame(onScrollFrame);
						}
						this.endScrollHandler();
						lt = dt;
					}
				};
				requestAnimationFrame(onScrollFrame);
				this.endScrollHandler();
			}
		});
		this.element.addEventListener("wheel", (evt) => {
			if (this.beginScrollHandler()) {
				if (evt.deltaMode === evt.DOM_DELTA_PIXEL) {
					this.scrollOffset += evt.deltaY;
					this.limitScrollOffset();
					this.calcLayout(true);
				} else {
					this.scrollOffset += evt.deltaY * 50;
					this.limitScrollOffset();
					this.calcLayout(false);
				}
				this.endScrollHandler();
			}
		});
	}
	private beginScrollHandler() {
		const allowed = this.allowScroll;
		if (allowed) {
			this.isScrolled = true;
			this.invokedByScrollEvent = true;
			clearTimeout(this.scrolledHandler);
			this.scrolledHandler = setTimeout(() => {
				this.isScrolled = false;
				this.scrollOffset = 0;
			}, 5000);
		}
		return allowed;
	}
	private endScrollHandler() {
		this.invokedByScrollEvent = false;
	}
	private limitScrollOffset() {
		this.scrollOffset = Math.max(
			Math.min(this.scrollBoundary[1], this.scrollOffset),
			this.scrollBoundary[0],
		);
	}
	/**
	 * 获取当前播放时间里是否处于间奏区间
	 * 如果是则会返回单位为毫秒的始末时间
	 * 否则返回 undefined
	 *
	 * 这个只允许内部调用
	 * @returns [开始时间,结束时间,大概处于的歌词行ID,下一句是否为对唱歌词] 或 undefined 如果不处于间奏区间
	 */
	getCurrentInterlude(): [number, number, number, boolean] | undefined {
		if (this.bufferedLines.size > 0) return undefined;
		const currentTime = this.currentTime + 20;
		const i = this.scrollToIndex;
		if (i === 0) {
			if (this.processedLines[0]?.startTime) {
				if (this.processedLines[0].startTime > currentTime) {
					return [
						currentTime,
						Math.max(currentTime, this.processedLines[0].startTime - 250),
						-2,
						this.processedLines[0].isDuet,
					];
				}
				if (
					this.processedLines[1].startTime > currentTime &&
					this.processedLines[0].endTime < currentTime
				) {
					return [
						Math.max(this.processedLines[0].endTime, currentTime),
						this.processedLines[1].startTime,
						0,
						this.processedLines[1].isDuet,
					];
				}
			}
		} else if (
			this.processedLines[i]?.endTime &&
			this.processedLines[i + 1]?.startTime
		) {
			if (
				this.processedLines[i + 1].startTime > currentTime &&
				this.processedLines[i].endTime < currentTime
			) {
				return [
					Math.max(this.processedLines[i].endTime, currentTime),
					this.processedLines[i + 1].startTime,
					i,
					this.processedLines[i + 1].isDuet,
				];
			}
			if (
				this.processedLines[i + 2]?.startTime &&
				this.processedLines[i + 2].startTime > currentTime &&
				this.processedLines[i + 1].endTime < currentTime
			) {
				return [
					Math.max(this.processedLines[i + 1].endTime, currentTime),
					this.processedLines[i + 2].startTime,
					i + 1,
					this.processedLines[i + 2].isDuet,
				];
			}
		}
		return undefined;
	}
	/**
	 * 重建样式
	 *
	 * 这个只允许内部调用
	 *
	 * @private
	 */
	rebuildStyle() {
		this._baseFontSize = Number.parseFloat(
			getComputedStyle(this.element).fontSize,
		);
		let style = "";
		style += "--amll-lp-width:";
		const width = this.innerSize[0] - this._baseFontSize * 2;
		style += `${width.toFixed(4)}px;`;
		style += "--amll-lp-height:";
		style += `${(this.innerSize[1] - this._baseFontSize * 2).toFixed(4)}px;`;
		// 原本想用 calc 来计算的，但是发现算式复杂之后无法解析，所以只能用 JS 来计算直接结果了
		style += "--amll-lp-line-width:";
		if (this.innerSize[0] < 768) {
			style += `${width.toFixed(4)}px;`;
		} else {
			style += `${(width * 0.8).toFixed(4)}px;`;
		}

		// style += "--amll-player-time:";
		// style += this.currentTime;
		// style += ";";
		this.element.setAttribute("style", style);
	}
	/**
	 * 设置是否隐藏已经播放过的歌词行，默认不隐藏
	 * @param hide 是否隐藏已经播放过的歌词行，默认不隐藏
	 */
	setHidePassedLines(hide: boolean) {
		this.hidePassedLines = hide;
		this.calcLayout();
	}
	/**
	 * 设置是否启用歌词行的模糊效果
	 * @param enable 是否启用
	 */
	setEnableBlur(enable: boolean) {
		if (this.enableBlur === enable) return;
		this.enableBlur = enable;
		this.calcLayout();
	}

	public get wordFadeWidth() {
		return this._wordFadeWidth;
	}

	/**
	 * 设置文字动画的渐变宽度，单位以歌词行的主文字字体大小的倍数为单位，默认为 0.5，即一个全角字符的一半宽度
	 *
	 * 如果要模拟 Apple Music for Android 的效果，可以设置为 1
	 *
	 * 如果要模拟 Apple Music for iPad 的效果，可以设置为 0.5
	 *
	 * 如果想要近乎禁用渐变效果，可以设置成非常接近 0 的小数（例如 `0.0001` ），但是**不可以为 0**
	 *
	 * @param value 需要设置的渐变宽度，单位以歌词行的主文字字体大小的倍数为单位，默认为 0.5
	 */
	setWordFadeWidth(value = 0.5) {
		this._wordFadeWidth = Math.max(0.0001, value);
		for (const el of this.lyricLinesEl) {
			el.markMaskImageDirty();
		}
	}

	/**
	 * 设置当前播放歌词，要注意传入后这个数组内的信息不得修改，否则会发生错误
	 * @param lines 歌词数组
	 * @param initialTime 初始时间，默认为 0
	 */
	setLyricLines(lines: LyricLine[], initialTime = 0) {
		for (const line of lines) {
			for (const word of line.words) {
				word.word = word.word.replace(/\s+/g, " ");
			}
		}
		this.lastCurrentTime = initialTime;
		this.currentTime = initialTime;
		this.lyricLines = lines;
		this.processedLines = structuredClone(lines) as LyricLine[];

		this.isNonDynamic = true;
		this.isNonDuet = true;
		for (const line of this.processedLines) {
			if (line.words.length > 1) {
				this.isNonDynamic = false;
				break;
			}
		}
		for (const line of this.processedLines) {
			if (line.isDuet) {
				this.isNonDuet = false;
				break;
			}
		}
		this.rebuildStyle();

		// 将行间有较短空隙的两个歌词行的结束时间拉长，与下一行歌词行的开始时间一致，以便于更好的显示
		this.processedLines.forEach((line, i, lines) => {
			const nextLine = lines[i + 1];
			const lastWord = line.words[line.words.length - 1];
			if (lastWord) {
				if (nextLine) {
					if (nextLine.startTime > line.endTime) {
						line.endTime = Math.min(line.endTime + 1500, nextLine.startTime);
					}
				} else {
					line.endTime = line.endTime + 1500;
				}
			}
		});

		// 让背景歌词和上一行歌词一同出现
		this.processedLines.forEach((line, i, lines) => {
			if (line.isBG) return;
			const nextLine = lines[i + 1];
			if (nextLine?.isBG) {
				nextLine.startTime = Math.min(nextLine.startTime, line.startTime);
			}
		});
		for (const line of this.lyricLinesEl) {
			line.removeMouseEventListener("click", this.onLineClickedHandler);
			line.removeMouseEventListener("contextmenu", this.onLineClickedHandler);
			line.dispose();
		}

		// 创建新的歌词行元素
		this.lyricLinesEl = this.processedLines.map((line) => {
			const lineEl = new LyricLineEl(this, line);
			lineEl.addMouseEventListener("click", this.onLineClickedHandler);
			lineEl.addMouseEventListener("contextmenu", this.onLineClickedHandler);
			return lineEl;
		});

		this.lyricLinesEl.forEach((el, i) => {
			this.element.appendChild(el.getElement());
			this.lyricLinesIndexes.set(el, i);
			el.markMaskImageDirty();
		});
		this.interludeDots.setInterlude(undefined);
		this.hotLines.clear();
		this.bufferedLines.clear();
		this.setLinePosXSpringParams({});
		this.setLinePosYSpringParams({});
		this.setLineScaleSpringParams({});
		this.resetScroll();
		this.setCurrentTime(0, true);
		this.calcLayout(true, true);
	}
	/**
	 * 重置用户滚动状态
	 *
	 * 请在用户完成滚动点击跳转歌词时调用本事件再调用 `calcLayout` 以正确滚动到目标位置
	 */
	resetScroll() {
		this.isScrolled = false;
		this.scrollOffset = 0;
		this.invokedByScrollEvent = false;
		clearTimeout(this.scrolledHandler);
		this.scrolledHandler = 0;
	}
	/**
	 * 重新布局定位歌词行的位置，调用完成后再逐帧调用 `update`
	 * 函数即可让歌词通过动画移动到目标位置。
	 *
	 * 函数有一个 `force` 参数，用于指定是否强制修改布局，也就是不经过动画直接调整元素位置和大小。
	 *
	 * 此函数还有一个 `reflow` 参数，用于指定是否需要重新计算布局
	 *
	 * 因为计算布局必定会导致浏览器重排布局，所以会大幅度影响流畅度和性能，故请只在以下情况下将其​设置为 true：
	 *
	 * 1. 歌词页面大小发生改变时（这个组件会自行处理）
	 * 2. 加载了新的歌词时（不论前后歌词是否完全一样）
	 * 3. 用户自行跳转了歌曲播放位置（不论距离远近）
	 *
	 * @param force 是否不经过动画直接修改布局定位
	 * @param reflow 是否进行重新布局（重新计算每行歌词大小）
	 */
	calcLayout(force = false, reflow = false) {
		if (reflow) {
			// this.emUnit = Number.parseFloat(getComputedStyle(this.element).fontSize);
			for (const el of this.lyricLinesEl) {
				const size: [number, number] = el.measureSize();
				this.lyricLinesSize.set(el, size);
				el.lineSize = size;
			}
			this.interludeDotsSize[0] = this.interludeDots.getElement().clientWidth;
			this.interludeDotsSize[1] = this.interludeDots.getElement().clientHeight;

			this.bottomLine.lineSize = this.bottomLine.measureSize();
		}
		const interlude = this.getCurrentInterlude();
		let curPos = -this.scrollOffset;
		let targetAlignIndex = this.scrollToIndex;
		let interludeDuration = 0;
		if (interlude) {
			interludeDuration = interlude[1] - interlude[0];
			if (interludeDuration >= 4000) {
				const nextLine = this.lyricLinesEl[interlude[2] + 1];
				if (nextLine) {
					targetAlignIndex = interlude[2] + 1;
				}
			}
		} else {
			this.interludeDots.setInterlude(undefined);
		}
		const scrollOffset = this.lyricLinesEl
			.slice(0, targetAlignIndex)
			.reduce(
				(acc, el) =>
					acc +
					(el.getLine().isBG ? 0 : (this.lyricLinesSize.get(el)?.[1] ?? 0)),
				0,
			);
		this.scrollBoundary[0] = -scrollOffset;
		curPos -= scrollOffset;
		curPos += this.size[1] * this.alignPosition;
		const curLine = this.lyricLinesEl[targetAlignIndex];
		if (curLine) {
			const lineHeight = this.lyricLinesSize.get(curLine)?.[1] ?? 0;
			switch (this.alignAnchor) {
				case "bottom":
					curPos -= lineHeight;
					break;
				case "center":
					curPos -= lineHeight / 2;
					break;
				case "top":
					break;
			}
		}
		const latestIndex = Math.max(...this.bufferedLines);
		let delay = 0;
		let baseDelay = 0.05;
		let setDots = false;
		this.lyricLinesEl.forEach((el, i) => {
			const hasBuffered = this.bufferedLines.has(i);
			const isActive =
				hasBuffered || (i >= this.scrollToIndex && i < latestIndex);
			const line = el.getLine();
			let left = 24;
			if (line.isDuet) {
				left = this.size[0] - (this.lyricLinesSize.get(el)?.[0] ?? 0);
			}
			if (
				!setDots &&
				interludeDuration >= 4000 &&
				((i === this.scrollToIndex && interlude?.[2] === -2) ||
					i === this.scrollToIndex + 1)
			) {
				setDots = true;
				this.interludeDots.setTransform(24, curPos + 10);
				if (interlude) {
					this.interludeDots.setInterlude([interlude[0], interlude[1]]);
				}
				curPos += this.interludeDotsSize[1] + 40;
			}
			let targetOpacity: number;
			let targetSubOpacity: number;

			if (this.hidePassedLines) {
				if (i < (interlude ? interlude[2] + 1 : this.scrollToIndex)) {
					targetOpacity = 0;
					targetSubOpacity = 0;
				} else if (hasBuffered) {
					targetOpacity = 0.85;
					targetSubOpacity = 0.4;
				} else {
					targetOpacity = this.isNonDynamic ? 0.2 : 1;
					targetSubOpacity = 0.2;
				}
			} else {
				if (hasBuffered) {
					targetOpacity = 0.85;
					targetSubOpacity = 0.4;
				} else {
					targetOpacity = this.isNonDynamic ? 0.2 : 1;
					targetSubOpacity = 0.2;
				}
			}

			let blurLevel = 0;
			if (this.enableBlur) {
				if (isActive) {
					blurLevel = 0;
				} else {
					blurLevel = 1;
					if (i < this.scrollToIndex) {
						blurLevel += Math.abs(this.scrollToIndex - i) + 1;
					} else {
						blurLevel += Math.abs(
							i - Math.max(this.scrollToIndex, latestIndex),
						);
					}
				}
			}
			if (this.invokedByScrollEvent) {
				blurLevel = 0;
			}

			const SCALE_ASPECT = this.enableScale ? 97 : 100;

			el.setTransform(
				left,
				curPos,
				isActive ? 100 : line.isBG ? 75 : SCALE_ASPECT,
				targetOpacity,
				targetSubOpacity,
				window.innerWidth <= 1024 ? blurLevel * 0.8 : blurLevel,
				force,
				delay,
			);
			if (line.isBG && isActive) {
				curPos += this.lyricLinesSize.get(el)?.[1] ?? 0;
			} else if (!line.isBG) {
				curPos += this.lyricLinesSize.get(el)?.[1] ?? 0;
			}
			if (curPos >= 0 && !this.isSeeking) {
				if (!line.isBG) delay += baseDelay;
				// if (i >= this.scrollToIndex - 1) baseDelay *= 1.05;
				// baseDelay = Math.min(baseDelay, 0.055);

				// delay += 0.05;

				// baseDelay = baseDelay > 0.15 ? 0 : baseDelay;
				// delay = (i - this.scrollToIndex) * 0.06;
				if (i >= this.scrollToIndex) baseDelay /= 1.05;
				// baseDelay = Math.max(baseDelay, 0.04);
			}
		});
		this.scrollBoundary[1] = curPos + this.scrollOffset - this.size[1] / 2;
		// console.groupEnd();
		this.bottomLine.setTransform(24, curPos, force, delay);
	}
	/**
	 * 获取当前歌词的播放位置
	 *
	 * 一般和最后调用 `setCurrentTime` 给予的参数一样
	 * @returns 当前播放位置
	 */
	getCurrentTime() {
		return this.currentTime;
	}
	/**
	 * 获取当前歌词数组
	 *
	 * 一般和最后调用 `setLyricLines` 给予的参数一样
	 * @returns 当前歌词数组
	 */
	getLyricLines() {
		return this.lyricLines;
	}
	getElement(): HTMLElement {
		return this.element;
	}
	/**
	 * 获取一个特殊的底栏元素，默认是空白的，可以往内部添加任意元素
	 *
	 * 这个元素始终在歌词的底部，可以用于显示歌曲创作者等信息
	 *
	 * 但是请勿删除该元素，只能在内部存放元素
	 *
	 * @returns 一个元素，可以往内部添加任意元素
	 */
	getBottomLineElement(): HTMLElement {
		return this.bottomLine.getElement();
	}
	/**
	 * 设置目标歌词行的对齐方式，默认为 `center`
	 *
	 * - 设置成 `top` 的话将会向目标歌词行的顶部对齐
	 * - 设置成 `bottom` 的话将会向目标歌词行的底部对齐
	 * - 设置成 `center` 的话将会向目标歌词行的垂直中心对齐
	 * @param alignAnchor 歌词行对齐方式，详情见函数说明
	 */
	setAlignAnchor(alignAnchor: "top" | "bottom" | "center") {
		this.alignAnchor = alignAnchor;
	}
	/**
	 * 设置默认的歌词行对齐位置，相对于整个歌词播放组件的大小位置，默认为 `0.5`
	 * @param alignPosition 一个 `[0.0-1.0]` 之间的任意数字，代表组件高度由上到下的比例位置
	 */
	setAlignPosition(alignPosition: number) {
		this.alignPosition = alignPosition;
	}
	/**
	 * 设置当前播放进度，单位为毫秒且**必须是整数**，此时将会更新内部的歌词进度信息
	 * 内部会根据调用间隔和播放进度自动决定如何滚动和显示歌词，所以这个的调用频率越快越准确越好
	 *
	 * 调用完成后，可以每帧调用 `update` 函数来执行歌词动画效果
	 * @param time 当前播放进度，单位为毫秒
	 */
	setCurrentTime(time: number, isSeek = false) {
		// 我在这里定义了歌词的选择状态：
		// 普通行：当前不处于时间范围内的歌词行
		// 热行：当前绝对处于播放时间内的歌词行，且一般会被立刻加入到缓冲行中
		// 缓冲行：一般处于播放时间后的歌词行，会因为当前播放状态的缘故推迟解除状态

		// 然后我们需要让歌词行为如下：
		// 如果当前仍有缓冲行的情况下加入新热行，则不会解除当前缓冲行，且也不会修改当前滚动位置
		// 如果当前所有缓冲行都将被删除且没有新热行加入，则删除所有缓冲行，且也不会修改当前滚动位置
		// 如果当前所有缓冲行都将被删除且有新热行加入，则删除所有缓冲行并加入新热行作为缓冲行，然后修改当前滚动位置
		this.initializeSeeking = isSeek;
		this.currentTime = time;
		if (Math.abs(this.currentTime - this.lastCurrentTime) >= 100) {
			this.initializeSeeking = true;
		} else this.initializeSeeking = false;
		if (!this.isPageVisible) return;
		if (!this._getIsNonDynamic() && !this.supportMaskImage)
			this.element.style.setProperty("--amll-player-time", `${time}`);
		if (this.isScrolled) return;
		const removedHotIds = new Set<number>();
		const removedIds = new Set<number>();
		const addedIds = new Set<number>();

		if (isSeek) {
			for (const line of this.lyricLinesEl) {
				line.setMaskAnimationState(time);
			}
		}

		// 先检索当前已经超出时间范围的缓冲行，列入待删除集内
		for (const lastHotId of this.hotLines) {
			const line = this.processedLines[lastHotId];
			if (line) {
				if (line.isBG) return;
				const nextLine = this.processedLines[lastHotId + 1];
				if (nextLine?.isBG) {
					const nextMainLine = this.processedLines[lastHotId + 2];
					const startTime = Math.min(line.startTime, nextLine?.startTime);
					const endTime = Math.min(
						Math.max(line.endTime, nextMainLine?.startTime ?? Number.MAX_VALUE),
						Math.max(line.endTime, nextLine?.endTime),
					);
					if (startTime > time || endTime <= time) {
						this.hotLines.delete(lastHotId);
						removedHotIds.add(lastHotId);
						this.hotLines.delete(lastHotId + 1);
						removedHotIds.add(lastHotId + 1);
						if (isSeek) {
							this.lyricLinesEl[lastHotId].disable(time);
							this.lyricLinesEl[lastHotId + 1].disable(time);
						}
					}
				} else if (line.startTime > time || line.endTime <= time) {
					this.hotLines.delete(lastHotId);
					removedHotIds.add(lastHotId);
					if (isSeek) this.lyricLinesEl[lastHotId].disable(time);
				}
			} else {
				this.hotLines.delete(lastHotId);
				removedHotIds.add(lastHotId);
				if (isSeek) this.lyricLinesEl[lastHotId].disable(time);
			}
		}
		this.processedLines.forEach((line, id, arr) => {
			if (!line.isBG && line.startTime <= time && line.endTime > time) {
				if (!this.hotLines.has(id)) {
					this.hotLines.add(id);
					addedIds.add(id);
					if (isSeek) this.lyricLinesEl[id].enable(time);
					if (arr[id + 1]?.isBG) {
						this.hotLines.add(id + 1);
						addedIds.add(id + 1);
						if (isSeek) this.lyricLinesEl[id + 1].enable(time);
					}
				}
			}
		});
		for (const v of this.bufferedLines) {
			if (!this.hotLines.has(v)) {
				removedIds.add(v);
				if (isSeek) this.lyricLinesEl[v].disable(time);
			}
		}
		if (isSeek) {
			if (this.bufferedLines.size > 0) {
				this.scrollToIndex = Math.min(...this.bufferedLines);
			} else {
				this.scrollToIndex = this.processedLines.findIndex(
					(line) => line.startTime >= time,
				);
			}
			this.bufferedLines.clear();
			for (const v of this.hotLines) {
				this.bufferedLines.add(v);
			}
			this.calcLayout(true);
		} else if (removedIds.size > 0 || addedIds.size > 0) {
			if (removedIds.size === 0 && addedIds.size > 0) {
				for (const v of addedIds) {
					this.bufferedLines.add(v);
					this.lyricLinesEl[v].enable(time);
				}
				this.scrollToIndex = Math.min(...this.bufferedLines);
				this.calcLayout();
			} else if (addedIds.size === 0 && removedIds.size > 0) {
				if (eqSet(removedIds, this.bufferedLines)) {
					for (const v of this.bufferedLines) {
						if (!this.hotLines.has(v)) {
							this.bufferedLines.delete(v);
							this.lyricLinesEl[v].disable(time);
						}
					}
					this.calcLayout();
				}
			} else {
				for (const v of addedIds) {
					this.bufferedLines.add(v);
					this.lyricLinesEl[v].enable(time);
				}
				for (const v of removedIds) {
					this.bufferedLines.delete(v);
					this.lyricLinesEl[v].disable(time);
				}
				if (this.bufferedLines.size > 0)
					this.scrollToIndex = Math.min(...this.bufferedLines);
				this.calcLayout();
			}
		}
		this.lastCurrentTime = time;
	}
	/**
	 * 暂停部分效果演出，目前会暂停播放间奏点的动画
	 */
	pause() {
		this.interludeDots.pause();
		for (const line of this.lyricLinesEl) {
			line.pause(this.currentTime);
		}
	}
	/**
	 * 恢复部分效果演出，目前会恢复播放间奏点的动画
	 */
	resume() {
		this.interludeDots.resume();
		for (const line of this.lyricLinesEl) {
			line.resume(this.currentTime);
		}
	}
	/**
	 * 更新动画，这个函数应该被逐帧调用或者在以下情况下调用一次：
	 *
	 * 1. 刚刚调用完设置歌词函数的时候
	 * @param delta 距离上一次被调用到现在的时长，单位为毫秒（可为浮点数）
	 */
	update(delta = 0) {
		if (!this.isPageVisible) return;
		const deltaS = delta / 1000;
		this.interludeDots.update(delta);
		this.bottomLine.update(deltaS);
		for (const line of this.lyricLinesEl) {
			line.update(deltaS);
		}
	}

	/**
	 * 设置所有歌词行在横坐标上的弹簧属性，包括重量、弹力和阻力。
	 *
	 * @param params 需要设置的弹簧属性，提供的属性将会覆盖原来的属性，未提供的属性将会保持原样
	 */
	setLinePosXSpringParams(params: Partial<SpringParams>) {
		this.posXSpringParams = {
			...this.posXSpringParams,
			...params,
		};
		this.bottomLine.lineTransforms.posX.updateParams(this.posXSpringParams);
		for (const line of this.lyricLinesEl) {
			line.lineTransforms.posX.updateParams(this.posXSpringParams);
		}
	}
	/**
	 * 设置所有歌词行在​纵坐标上的弹簧属性，包括重量、弹力和阻力。
	 *
	 * @param params 需要设置的弹簧属性，提供的属性将会覆盖原来的属性，未提供的属性将会保持原样
	 */
	setLinePosYSpringParams(params: Partial<SpringParams>) {
		this.posYSpringParams = {
			...this.posYSpringParams,
			...params,
		};
		this.bottomLine.lineTransforms.posY.updateParams(this.posYSpringParams);
		for (const line of this.lyricLinesEl) {
			line.lineTransforms.posY.updateParams(this.posYSpringParams);
		}
	}
	/**
	 * 设置所有歌词行在​缩放大小上的弹簧属性，包括重量、弹力和阻力。
	 *
	 * @param params 需要设置的弹簧属性，提供的属性将会覆盖原来的属性，未提供的属性将会保持原样
	 */
	setLineScaleSpringParams(params: Partial<SpringParams>) {
		this.scaleSpringParams = {
			...this.scaleSpringParams,
			...params,
		};
		this.scaleForBGSpringParams = {
			...this.scaleForBGSpringParams,
			...params,
		};
		for (const line of this.lyricLinesEl) {
			if (line.getLine().isBG) {
				line.lineTransforms.scale.updateParams(this.scaleForBGSpringParams);
			} else {
				line.lineTransforms.scale.updateParams(this.scaleSpringParams);
			}
		}
	}
	dispose(): void {
		this.element.remove();
		this.resizeObserver.disconnect();
		for (const el of this.lyricLinesEl) {
			el.dispose();
		}
		window.removeEventListener("pageshow", this.onPageShow);
		this.bottomLine.dispose();
		this.interludeDots.dispose();
	}
}
