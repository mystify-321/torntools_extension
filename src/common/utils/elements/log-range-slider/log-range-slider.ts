import "./log-range-slider.css";
import { elementBuilder, findAllElements } from "@common/utils/functions/dom";
import { getUUID } from "@common/utils/functions/utilities";

export interface LogRangeSliderOptions {
	min: number;
	max: number;
	// Smallest value (greater than 'min') the logarithmic scale grows from. Needed since log(0) is undefined.
	minPositive: number;
	valueLow: number;
	valueHigh: number;
}

const KEYBOARD_STEP_PERCENTAGE = 0.01;

export class LogRangeSlider {
	private readonly options: LogRangeSliderOptions;
	private readonly uuid: string;
	private startPos: number;
	slider: HTMLElement | undefined;
	private activeHandle: HTMLElement | undefined;
	private handles: HTMLElement[];
	private readonly moveTouchListener = this.moveTouch.bind(this);
	private readonly moveListener = this.move.bind(this);

	constructor(options: Partial<LogRangeSliderOptions> = {}) {
		this.options = {
			min: 0,
			max: 100,
			minPositive: 1,
			valueLow: options.min ?? 0,
			valueHigh: options.max ?? 100,
			...options,
		};

		this.uuid = getUUID();
		this.startPos = 0;
		this.handles = [];

		this._createElement();
	}

	_createElement() {
		this.slider = elementBuilder({
			type: "div",
			class: "tt-log-range",
			html: `
				<label for="handle-left_${this.uuid}" class="handle left"></label>
				<span class="highlight"></span>
				<label for="handle-right_${this.uuid}" class="handle right"></label>
				<div class="dump">
					<input id="handle-left_${this.uuid}"/>
					<input id="handle-right_${this.uuid}"/>
				</div>
			`,
		});
		this.handles = findAllElements(".handle", this.slider);

		this.handles.forEach((handle) => {
			const input = this.slider.querySelector<HTMLElement>(`#${handle.getAttribute("for")}`);

			handle.addEventListener("mousedown", this.startMove.bind(this));
			handle.addEventListener("touchstart", this.startMoveTouch.bind(this));

			handle.addEventListener("click", () => input.focus());

			input.addEventListener("focus", () => handle.classList.add("focus"));
			input.addEventListener("blur", () => handle.classList.remove("focus"));
			input.addEventListener("keydown", this.moveKeyboard.bind(this));
		});

		this.updateValue(this.handles[0], this.options.valueLow);
		this.updateValue(this.handles[1], this.options.valueHigh);

		window.addEventListener("mouseup", this.stopMove.bind(this));
		window.addEventListener("touchend", this.stopMove.bind(this));
		window.addEventListener("touchcancel", this.stopMove.bind(this));
		window.addEventListener("touchleave", this.stopMove.bind(this));
	}

	startMoveTouch(event: TouchEvent) {
		const handleRect = (event.target as HTMLElement).getBoundingClientRect();
		this.startPos = event.touches[0].clientX - handleRect.x;
		this.activeHandle = event.target as HTMLElement;
		window.addEventListener("touchmove", this.moveTouchListener);
	}

	startMove(event: MouseEvent) {
		this.startPos = event.offsetX;
		this.activeHandle = event.target as HTMLElement;
		window.addEventListener("mousemove", this.moveListener);
	}

	moveKeyboard(event: KeyboardEvent) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

		const handle = this.slider.querySelector<HTMLElement>(`.handle[for="${(event.target as Element).id}"]`);
		if (!handle) return;

		const percentage = this.valueToPercentage(parseFloat(handle.dataset.value));
		const direction = event.key === "ArrowLeft" ? -1 : 1;

		this.updateValue(handle, this.percentageToValue(percentage + direction * KEYBOARD_STEP_PERCENTAGE));
	}

	moveTouch(event: TouchEvent) {
		this.move({ clientX: event.touches[0].clientX });
	}

	move(event: { clientX: number }) {
		const parentRect = this.slider.getBoundingClientRect();
		const handleRect = this.activeHandle.getBoundingClientRect();

		const position = Math.max(Math.min(event.clientX - parentRect.x - this.startPos, parentRect.width - handleRect.width / 2), 0 - handleRect.width / 2);

		this.updateValue(this.activeHandle, this.percentageToValue((position + handleRect.width / 2) / parentRect.width));
	}

	// Maps a real-world value onto the 0-1 position of the track. Equal pixel distances cover equal ratios, not equal amounts.
	valueToPercentage(value: number): number {
		const { min, max, minPositive } = this.options;
		if (value <= min) return 0;
		if (value >= max) return 1;

		const clamped = Math.min(Math.max(value, minPositive), max);
		return Math.log(clamped / minPositive) / Math.log(max / minPositive);
	}

	percentageToValue(percentage: number): number {
		const { min, max, minPositive } = this.options;
		percentage = Math.min(Math.max(percentage, 0), 1);

		if (percentage <= 0) return min;
		if (percentage >= 1) return max;

		return minPositive * (max / minPositive) ** percentage;
	}

	updateValue(handle: HTMLElement, value: number) {
		value = Math.round(Math.max(Math.min(value, this.options.max), this.options.min));
		handle.dataset.value = value.toString();

		this.updateValues();
	}

	stopMove() {
		window.removeEventListener("mousemove", this.moveListener);
		window.removeEventListener("touchmove", this.moveTouchListener);
	}

	updateValues() {
		const valueLeft = parseFloat(this.handles[0].dataset.value);
		const valueRight = parseFloat(this.handles[1].dataset.value);

		const low = Math.min(valueLeft, valueRight);
		const high = Math.max(valueLeft, valueRight);

		this.updateHighlight("left", low);
		this.updateHighlight("right", high);

		this.slider.dataset.low = low.toString();
		this.slider.dataset.high = high.toString();
	}

	updateHighlight(side: string, value: number) {
		const rangeWidth = this.slider.getBoundingClientRect().width || 150;
		const handleWidth = this.handles[0].getBoundingClientRect().width || 21;

		const percentage = this.valueToPercentage(value);

		this.slider.style.setProperty(`--${side}`, `${percentage * rangeWidth - handleWidth / 2}px`);
	}
}
