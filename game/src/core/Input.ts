/**
 * FPS input: pointer lock mouse look, keyboard state, and edge-triggered
 * "pressed this frame" / "released this frame" queries for actions.
 */
export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  locked = false;
  /** Test hook / bot: when true, actions work without pointer lock. */
  allowUnlocked = false;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (['Space', 'ShiftLeft', 'ShiftRight', 'KeyF', 'Tab'].includes(e.code)) e.preventDefault();
    const code = normalize(e.code);
    if (!this.down.has(code)) this.pressed.add(code);
    this.down.add(code);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    const code = normalize(e.code);
    if (this.down.has(code)) this.released.add(code);
    this.down.delete(code);
  };

  private readonly onMouseDown = (e: MouseEvent) => {
    if (!this.locked && !this.allowUnlocked) return;
    const code = `Mouse${e.button}`;
    if (!this.down.has(code)) this.pressed.add(code);
    this.down.add(code);
  };

  private readonly onMouseUp = (e: MouseEvent) => {
    const code = `Mouse${e.button}`;
    if (this.down.has(code)) this.released.add(code);
    this.down.delete(code);
  };

  private readonly onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    // Clamp single-event spikes (some browsers emit huge deltas on lock).
    this.mouseDX += Math.max(-300, Math.min(300, e.movementX));
    this.mouseDY += Math.max(-300, Math.min(300, e.movementY));
  };

  private readonly onLockChange = () => {
    this.locked = document.pointerLockElement === this.target;
    if (!this.locked) this.releaseAll();
  };

  private readonly onContext = (e: Event) => e.preventDefault();
  private readonly onBlur = () => this.releaseAll();

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('contextmenu', this.onContext);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  requestLock(): void {
    const req = this.target.requestPointerLock?.bind(this.target);
    if (!req) return;
    try {
      const result = req({ unadjustedMovement: true } as never) as unknown;
      if (result instanceof Promise) result.catch(() => req());
    } catch {
      req();
    }
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  wasReleased(code: string): boolean {
    return this.released.has(code);
  }

  consumeMouse(): { dx: number; dy: number } {
    const r = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return r;
  }

  /** Bot/test injection. */
  inject(code: string, isDown: boolean): void {
    if (isDown) {
      if (!this.down.has(code)) this.pressed.add(code);
      this.down.add(code);
    } else {
      if (this.down.has(code)) this.released.add(code);
      this.down.delete(code);
    }
  }

  injectMouse(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  /** Call at the end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
  }

  private releaseAll(): void {
    for (const c of this.down) this.released.add(c);
    this.down.clear();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('contextmenu', this.onContext);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onLockChange);
  }
}

function normalize(code: string): string {
  if (code === 'ShiftRight') return 'ShiftLeft';
  return code;
}
