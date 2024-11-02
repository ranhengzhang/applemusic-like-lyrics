/**
 * @fileoverview
 * 一个播放歌词的组件
 * @author SteveXMH
 */

import type { LyricLine } from "../../interfaces";
import "../../styles/index.css";
import styles from "../../styles/lyric-player.module.css";
import { debounce } from "../../utils/debounce.js";
import { LyricPlayerBase } from "../base";
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
export class DomLyricPlayer extends LyricPlayerBase {
	override currentLyricLineObjects: LyricLineEl[] = [];

	private debounceCalcLayout = debounce(
		() =>
			this.calcLayout(true, true).then(() =>
				this.currentLyricLineObjects.map(async (el, i) => {
					el.markMaskImageDirty("DomLyricPlayer onResize");
					await el.waitMaskImageUpdated();
					if (this.hotLines.has(i)) {
						el.enable(this.currentTime);
						el.resume();
					}
				}),
			),
		100,
	);

	override onResize(): void {
		const computedStyles = getComputedStyle(this.element);
		this._baseFontSize = Number.parseFloat(computedStyles.fontSize);
		const innerWidth =
			this.element.clientWidth -
			Number.parseFloat(computedStyles.paddingLeft) -
			Number.parseFloat(computedStyles.paddingRight);
		const innerHeight =
			this.element.clientHeight -
			Number.parseFloat(computedStyles.paddingTop) -
			Number.parseFloat(computedStyles.paddingBottom);
		this.innerSize[0] = innerWidth;
		this.innerSize[1] = innerHeight;
		this.rebuildStyle();
		for (const obj of this.currentLyricLineObjects) {
			if (!obj.getElement().classList.contains(styles.dirty))
				obj.getElement().classList.add(styles.dirty);
		}
		this.debounceCalcLayout();
	}

	readonly supportPlusLighter = CSS.supports("mix-blend-mode", "plus-lighter");
	readonly supportMaskImage = CSS.supports("mask-image", "none");
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
	private _baseFontSize = Number.parseFloat(
		getComputedStyle(this.element).fontSize,
	);
	public get baseFontSize() {
		return this._baseFontSize;
	}
	constructor() {
		super();
		this.onResize();
		this.element.classList.add("amll-lyric-player", "dom");
		if (this.disableSpring) {
			this.element.classList.add(styles.disableSpring);
		}
	}

	private rebuildStyle() {
		const width = this.innerSize[0];
		const height = this.innerSize[1];
		this.element.style.setProperty("--amll-lp-width", `${width.toFixed(4)}px`);
		this.element.style.setProperty(
			"--amll-lp-height",
			`${height.toFixed(4)}px`,
		);
	}

	override setWordFadeWidth(value = 0.5) {
		super.setWordFadeWidth(value);
		for (const el of this.currentLyricLineObjects) {
			el.markMaskImageDirty("DomLyricPlayer setWordFadeWidth");
		}
	}

	/**
	 * 设置当前播放歌词，要注意传入后这个数组内的信息不得修改，否则会发生错误
	 * @param lines 歌词数组
	 * @param initialTime 初始时间，默认为 0
	 */
	override setLyricLines(lines: LyricLine[], initialTime = 0) {
		super.setLyricLines(lines, initialTime);
		if (!this.isNonDynamic) {
			this.element.classList.add(styles.hasDuetLine);
		}

		for (const line of this.currentLyricLineObjects) {
			line.removeMouseEventListener("click", this.onLineClickedHandler);
			line.removeMouseEventListener("contextmenu", this.onLineClickedHandler);
			line.dispose();
		}

		// 创建新的歌词行元素
		this.currentLyricLineObjects = this.processedLines.map((line, i) => {
			const lineEl = new LyricLineEl(this, line);
			lineEl.addMouseEventListener("click", this.onLineClickedHandler);
			lineEl.addMouseEventListener("contextmenu", this.onLineClickedHandler);
			this.element.appendChild(lineEl.getElement());
			this.lyricLinesIndexes.set(lineEl, i);
			lineEl.markMaskImageDirty("DomLyricPlayer setLyricLines");
			return lineEl;
		});

		this.setLinePosXSpringParams({});
		this.setLinePosYSpringParams({});
		this.setLineScaleSpringParams({});
		this.calcLayout(true, true).then(() => {
			this.initialLayoutFinished = true;
		});
	}

	override pause() {
		super.pause();
		this.interludeDots.pause();
		for (const line of this.currentLyricLineObjects) {
			line.pause();
		}
	}

	override resume() {
		super.resume();
		this.interludeDots.resume();
		for (const line of this.currentLyricLineObjects) {
			line.resume();
		}
	}

	override update(delta = 0) {
		if (!this.initialLayoutFinished) return;
		super.update(delta);
		if (!this.isPageVisible) return;
		const deltaS = delta / 1000;
		this.interludeDots.update(delta);
		this.bottomLine.update(deltaS);
		for (const line of this.currentLyricLineObjects) {
			line.update(deltaS);
		}
	}

	override dispose(): void {
		super.dispose();
		this.element.remove();
		for (const el of this.currentLyricLineObjects) {
			el.dispose();
		}
		this.bottomLine.dispose();
		this.interludeDots.dispose();
	}
}
