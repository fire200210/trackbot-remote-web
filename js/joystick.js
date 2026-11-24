/**
 * Virtual joystick.
 *
 * mode "throttle": vertical only; bottom = 0 (stop), top = 1; release keeps value.
 * mode "fine": 2-axis; center = 0; release springs back to center.
 *
 * Center (cx/cy) is measured once on pointerdown and locked for the gesture
 * so layout/readout changes cannot drift the origin mid-drag.
 */
export class Joystick {
  /**
   * @param {HTMLElement} root
   * @param {{ mode: "throttle" | "fine", onChange?: (v: { x: number, y: number, t?: number }) => void }} options
   */
  constructor(root, options) {
    this.root = root;
    this.mode = options.mode;
    this.onChange = options.onChange || (() => {});
    this.base = root.querySelector(".stick-base");
    this.knob = root.querySelector(".stick-knob");
    this.pointerId = null;
    this.radius = 0;
    this.cx = 0;
    this.cy = 0;
    this.x = 0;
    this.y = this.mode === "throttle" ? 1 : 0;
    this._throttle = 0;
    /** Near-center snap so resting finger noise does not float axes. */
    this.deadzone = this.mode === "fine" ? 0.08 : 0.04;

    if (this.mode === "throttle") {
      this._setVisual(0, 1);
    } else {
      this._setVisual(0, 0);
    }

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);

    this.base.addEventListener("pointerdown", this._onPointerDown);
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
    window.addEventListener("pointercancel", this._onPointerUp);
  }

  /** @returns {{ x: number, y: number, t: number }} */
  getValue() {
    if (this.mode === "throttle") {
      return { x: 0, y: 0, t: this._throttle };
    }
    return { x: this.x, y: this.y, t: 0 };
  }

  destroy() {
    this.base.removeEventListener("pointerdown", this._onPointerDown);
    window.removeEventListener("pointermove", this._onPointerMove);
    window.removeEventListener("pointerup", this._onPointerUp);
    window.removeEventListener("pointercancel", this._onPointerUp);
  }

  _measure() {
    const rect = this.base.getBoundingClientRect();
    /* Full pad throw (~36% of base radius). */
    this.radius = Math.min(rect.width, rect.height) * 0.5 * 0.72;
    this.cx = rect.left + rect.width / 2;
    this.cy = rect.top + rect.height / 2;
  }

  _onPointerDown(e) {
    if (this.pointerId !== null) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.base.setPointerCapture?.(e.pointerId);
    this._measure(); /* lock origin for this gesture */
    this._updateFromEvent(e);
  }

  _onPointerMove(e) {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    /* Do not re-measure — keeps center locked while packet / chrome reflow. */
    this._updateFromEvent(e);
  }

  _onPointerUp(e) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.mode === "fine") {
      this.x = 0;
      this.y = 0;
      this._setVisual(0, 0);
      this.onChange(this.getValue());
    }
  }

  _applyDeadzone(n) {
    const z = this.deadzone;
    if (Math.abs(n) <= z) return 0;
    const sign = n < 0 ? -1 : 1;
    return sign * (Math.abs(n) - z) / (1 - z);
  }

  _updateFromEvent(e) {
    let dx = e.clientX - this.cx;
    let dy = e.clientY - this.cy;

    if (this.mode === "throttle") {
      dx = 0;
      const maxY = this.radius || 1;
      dy = Math.max(-maxY, Math.min(maxY, dy));
      const normY = dy / maxY;
      let t = clamp01((1 - normY) / 2);
      if (t <= this.deadzone) t = 0;
      else t = (t - this.deadzone) / (1 - this.deadzone);
      this._throttle = t;
      this.x = 0;
      this.y = normY;
      this._setVisual(0, normY);
      this.onChange(this.getValue());
      return;
    }

    const dist = Math.hypot(dx, dy);
    if (dist > this.radius && this.radius > 0) {
      const s = this.radius / dist;
      dx *= s;
      dy *= s;
    }
    const nx = this.radius ? dx / this.radius : 0;
    const ny = this.radius ? -dy / this.radius : 0;
    this.x = this._applyDeadzone(nx);
    this.y = this._applyDeadzone(ny);
    this._setVisual(nx, -ny); /* visual follows finger; values use deadzone */
    this.onChange(this.getValue());
  }

  /**
   * @param {number} nx -1..1 (right positive)
   * @param {number} nyScreen -1..1 where +1 is toward bottom of screen
   */
  _setVisual(nx, nyScreen) {
    const pctX = 50 + nx * 36;
    const pctY = 50 + nyScreen * 36;
    this.knob.style.left = `${pctX}%`;
    this.knob.style.top = `${pctY}%`;
    this.knob.style.transform = "translate(-50%, -50%)";
  }
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}
