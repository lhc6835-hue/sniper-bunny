const $ = <T extends HTMLElement = HTMLElement>(sel: string) => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing ${sel}`);
  return el;
};

export class Hud {
  readonly root = $('#hud');
  private readonly crosshair = $('#crosshair');
  private readonly hitmarker = $('#hitmarker');
  private readonly chargeRing = $('#charge-ring');
  private readonly chargeFg = document.querySelector<SVGCircleElement>('#charge-ring .fg')!;
  private readonly lock = $('#lock');
  private readonly combo = $('#combo');
  private readonly popups = $('#popups');
  private readonly dmgDirs = $('#damage-dirs');
  private readonly killfeed = $('#killfeed');
  private readonly waveNum = $('#wave-num');
  private readonly enemyCount = $('#enemy-count');
  private readonly score = $('#score');
  private readonly banner = $('#banner');
  private readonly hpFill = $('#hp-fill');
  private readonly hpText = $('#hp-text');
  private readonly hpBar = document.querySelector<HTMLElement>('.bar.hp')!;
  private readonly focusFill = $('#focus-fill');
  private readonly focusBar = document.querySelector<HTMLElement>('.bar.focus')!;
  private readonly jumps = Array.from(document.querySelectorAll<HTMLElement>('#jumps i'));
  private readonly ammo = $('#ammo');
  private readonly ammoHint = $('#ammo-hint');
  private readonly weaponSub = $('#weapon-sub');
  private readonly scope = $('#scope');
  private readonly scopeRange = $('#scope-range');
  private lastAmmo = -1;
  private lastScore = -1;
  private comboAnim: Animation | null = null;

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  setCrosshair(spreadPx: number, busy: boolean, visible: boolean): void {
    this.crosshair.style.setProperty('--spread', `${spreadPx.toFixed(1)}px`);
    this.crosshair.classList.toggle('busy', busy);
    this.crosshair.style.opacity = visible ? '1' : '0';
  }

  setScope(on: boolean, range: number): void {
    this.scope.classList.toggle('on', on);
    if (on) this.scopeRange.textContent = Number.isFinite(range) ? `${range.toFixed(0)} m` : '--- m';
  }

  hit(kind: 'hit' | 'kill' | 'head'): void {
    this.hitmarker.className = kind === 'hit' ? '' : kind;
    this.hitmarker.animate(
      [
        { opacity: 1, transform: `scale(${kind === 'head' ? 1.6 : 1.25})` },
        { opacity: 1, transform: 'scale(1)', offset: 0.3 },
        { opacity: 0, transform: 'scale(1)' },
      ],
      { duration: kind === 'hit' ? 220 : 420, easing: 'ease-out' },
    );
  }

  setCharge(k: number, on: boolean): void {
    this.chargeRing.classList.toggle('on', on);
    this.chargeRing.classList.toggle('full', k >= 1);
    this.chargeFg.style.strokeDashoffset = `${251.3 * (1 - k)}`;
  }

  setLock(x: number, y: number, on: boolean, t: number): void {
    this.lock.classList.toggle('on', on);
    if (on) this.lock.style.transform = `translate(${x}px, ${y}px) rotate(${Math.sin(t * 6) * 6}deg) scale(${1 + Math.sin(t * 14) * 0.04})`;
  }

  setCombo(n: number): void {
    if (n < 2) {
      this.combo.style.opacity = '0';
      return;
    }
    this.combo.textContent = `x${n}`;
    this.combo.style.opacity = '1';
    this.comboAnim?.cancel();
    this.comboAnim = this.combo.animate([{ transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 180, easing: 'ease-out' });
  }

  popup(text: string, pts: number, kind: 'head' | 'dagger' | 'kill'): void {
    const el = document.createElement('div');
    el.className = `popup ${kind}`;
    el.innerHTML = `${text}<span class="pts">+${pts}</span>`;
    this.popups.prepend(el);
    el.animate(
      [
        { opacity: 0, transform: 'translateY(10px) scale(1.8)' },
        { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.12 },
        { opacity: 1, offset: 0.75 },
        { opacity: 0, transform: 'translateY(-16px) scale(0.95)' },
      ],
      { duration: 1400, easing: 'cubic-bezier(.2,.9,.3,1)' },
    ).onfinish = () => el.remove();
    while (this.popups.children.length > 4) this.popups.lastElementChild?.remove();
  }

  feed(text: string, dagger = false): void {
    const el = document.createElement('div');
    el.className = `feed${dagger ? ' dagger' : ''}`;
    el.textContent = text;
    this.killfeed.prepend(el);
    el.animate([{ opacity: 0, transform: 'translateX(30px)' }, { opacity: 1, transform: 'none' }], { duration: 160 });
    setTimeout(() => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 }).onfinish = () => el.remove(), 3500);
    while (this.killfeed.children.length > 5) this.killfeed.lastElementChild?.remove();
  }

  damageFrom(angleRad: number): void {
    const el = document.createElement('div');
    el.className = 'dmg-dir';
    el.style.transform = `rotate(${angleRad}rad)`;
    this.dmgDirs.appendChild(el);
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, easing: 'ease-in' }).onfinish = () => el.remove();
  }

  banner_(big: string, small: string, ms = 2200): void {
    (this.banner.querySelector('.big') as HTMLElement).textContent = big;
    (this.banner.querySelector('.small') as HTMLElement).textContent = small;
    this.banner.animate(
      [
        { opacity: 0, transform: 'translate(-50%, -50%) scale(1.4)', letterSpacing: '0.4em' },
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', letterSpacing: '0.08em', offset: 0.15 },
        { opacity: 1, offset: 0.8 },
        { opacity: 0, transform: 'translate(-50%, -50%) scale(0.96)' },
      ],
      { duration: ms, easing: 'cubic-bezier(.2,.9,.3,1)' },
    );
  }

  setStatus(wave: number, enemies: number, score: number): void {
    this.waveNum.textContent = String(wave);
    this.enemyCount.textContent = String(enemies);
    if (score !== this.lastScore) {
      this.score.textContent = score.toLocaleString();
      if (this.lastScore >= 0) this.score.animate([{ transform: 'scale(1.3)', color: '#ffcf5a' }, { transform: 'scale(1)' }], { duration: 220 });
      this.lastScore = score;
    }
  }

  setHp(hp: number, max: number): void {
    const k = Math.max(0, hp / max);
    this.hpFill.style.transform = `scaleX(${k})`;
    this.hpText.textContent = String(Math.ceil(Math.max(0, hp)));
    this.hpBar.classList.toggle('low', k < 0.3);
  }

  setFocus(k: number, empty: boolean): void {
    this.focusFill.style.transform = `scaleX(${k})`;
    this.focusBar.classList.toggle('empty', empty);
  }

  setJumps(available: number): void {
    this.jumps.forEach((el, i) => el.classList.toggle('used', i >= available));
  }

  setAmmo(n: number, max: number, reloading: boolean, dagger: boolean): void {
    if (n !== this.lastAmmo) {
      this.ammo.innerHTML = '';
      for (let i = 0; i < max; i += 1) {
        const b = document.createElement('i');
        if (i >= n) b.className = 'spent';
        this.ammo.appendChild(b);
      }
      this.lastAmmo = n;
    }
    this.ammoHint.classList.toggle('on', n === 0 && !reloading);
    this.weaponSub.textContent = dagger ? '단검' : reloading ? '재장전 중' : '볼트액션';
  }

  reset(): void {
    this.lastAmmo = -1;
    this.lastScore = -1;
    this.killfeed.innerHTML = '';
    this.popups.innerHTML = '';
  }
}
