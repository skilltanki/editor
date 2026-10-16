// The loading screen: a real progress bar, not a spinner.
//
// Copy of packages/game/src/game/LoadingScreen.ts — deliberately a copy, not
// an import: each package owns its UI chrome (same reasoning as the obfuscator
// note in vite.config.ts). Keep the two in step.
// Differences from the game version:
//   - assetUrl comes from the editor's core/assetUrl, so the life_*.png strips
//     and the logo resolve against this package's base.
//
// Shows a percentage, the megabytes downloaded against the megabytes expected,
// and the name of the step in progress. The fill uses the SWF-extracted
// life_*.png strips — the same 9-slice bar the original drew its health with —
// so the editor's screen matches the game's.

import { assetUrl } from '../core/assetUrl';
const UI = assetUrl('/embedded/ui');

function style(el: HTMLElement, css: Partial<CSSStyleDeclaration>): void {
  Object.assign(el.style, css);
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export class LoadingScreen {
  private readonly overlay: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly phaseEl: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly percentEl: HTMLDivElement;
  private readonly counterEl: HTMLDivElement;

  /** Where the bar is heading, and where it is drawn — eased between frames. */
  private targetFraction = 0;
  private shownFraction = 0;
  private rafHandle: number | null = null;

  constructor() {
    this.overlay = document.createElement('div');
    style(this.overlay, {
      position: 'absolute',
      inset: '0',
      display: 'none',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '14px',
      background: 'radial-gradient(ellipse at center, rgba(10,14,10,0.55) 0%, rgba(4,6,4,0.92) 100%)',
      // Above the editor chrome (menubar sits at 20).
      zIndex: '40',
    });

    const logo = document.createElement('img');
    logo.src = assetUrl('/logo.png');
    style(logo, { width: 'min(230px, 36vw)', filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.8))' });
    this.overlay.appendChild(logo);

    const panel = document.createElement('div');
    style(panel, {
      background: 'rgba(16,18,16,0.92)',
      border: '1px solid rgba(255,255,255,0.25)',
      borderRadius: '6px',
      boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
      padding: '18px 22px',
      width: 'min(420px, 88vw)',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    });

    this.titleEl = document.createElement('div');
    style(this.titleEl, {
      font: 'bold 13px Verdana, Tahoma, sans-serif',
      color: '#fff',
      textAlign: 'center',
      letterSpacing: '1px',
    });
    panel.appendChild(this.titleEl);

    // Trough + fill, matching the game HUD's reload bar.
    const trough = document.createElement('div');
    style(trough, {
      position: 'relative',
      height: '16px',
      background: 'rgba(0,0,0,0.55)',
      border: '1px solid rgba(255,255,255,0.35)',
      borderRadius: '3px',
      overflow: 'hidden',
    });
    this.fill = document.createElement('div');
    style(this.fill, {
      height: '100%',
      width: '0%',
      background:
        `url("${UI}/life_left.png") left center/auto 100% no-repeat, ` +
        `url("${UI}/life_right.png") right center/auto 100% no-repeat, ` +
        `url("${UI}/life_center.png") left center/auto 100% repeat-x`,
    });
    trough.appendChild(this.fill);
    this.percentEl = document.createElement('div');
    style(this.percentEl, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: 'bold 11px Verdana, Tahoma, sans-serif',
      color: '#fff',
      textShadow: '0 1px 2px rgba(0,0,0,0.9)',
    });
    trough.appendChild(this.percentEl);
    panel.appendChild(trough);

    const footer = document.createElement('div');
    style(footer, { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' });
    this.phaseEl = document.createElement('div');
    style(this.phaseEl, {
      font: 'bold 11px Verdana, Tahoma, sans-serif',
      color: '#9c9',
      textTransform: 'uppercase',
      letterSpacing: '1px',
    });
    this.counterEl = document.createElement('div');
    // Monospace so the digits do not jitter as they tick up.
    style(this.counterEl, {
      font: 'bold 12px monospace',
      color: 'rgba(255,255,255,0.75)',
    });
    footer.appendChild(this.phaseEl);
    footer.appendChild(this.counterEl);
    panel.appendChild(footer);

    this.overlay.appendChild(panel);
    document.body.appendChild(this.overlay);
  }

  show(title: string, phase = ''): void {
    this.titleEl.textContent = title;
    this.phaseEl.textContent = phase;
    this.counterEl.textContent = '';
    this.percentEl.textContent = '0%';
    this.targetFraction = 0;
    this.shownFraction = 0;
    this.fill.style.width = '0%';
    this.overlay.style.display = 'flex';
    this.startAnimating();
  }

  setPhase(phase: string): void {
    this.phaseEl.textContent = phase;
  }

  /**
   * FILE-COUNT progress: the percent and the fill come from loaded/total
   * files (the map XML names them all up front), the megabytes tick as they
   * arrive, information only. The NUMBERS are exact — easing the digits would
   * make them look invented — while the bar itself eases, because files
   * settle in bursts and an un-eased fill jumps in visible steps.
   */
  setProgress(receivedBytes: number, loaded: number, total: number): void {
    const mb = `${formatMb(receivedBytes)} MB`;
    if (total <= 0) {
      this.counterEl.textContent = mb;
      this.percentEl.textContent = '';
      return;
    }
    const fraction = Math.max(0, Math.min(1, loaded / total));
    this.targetFraction = fraction;
    this.percentEl.textContent = `${Math.round(fraction * 100)}%`;
    this.counterEl.textContent = `${loaded} / ${total} · ${mb}`;
  }

  private startAnimating(): void {
    if (this.rafHandle != null) {
      return;
    }
    const step = (): void => {
      // Ease toward the target; the constant is a compromise between
      // smoothing the bursts and still feeling responsive.
      this.shownFraction += (this.targetFraction - this.shownFraction) * 0.18;
      if (Math.abs(this.targetFraction - this.shownFraction) < 0.001) {
        this.shownFraction = this.targetFraction;
      }
      this.fill.style.width = `${(this.shownFraction * 100).toFixed(2)}%`;
      this.rafHandle = requestAnimationFrame(step);
    };
    this.rafHandle = requestAnimationFrame(step);
  }

  /** Replaces the bar with an error; the load cannot continue. */
  fail(message: string): void {
    this.phaseEl.textContent = '';
    this.counterEl.textContent = '';
    this.percentEl.textContent = '';
    this.titleEl.textContent = message;
    this.titleEl.style.color = '#ff7a5a';
    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }
}
