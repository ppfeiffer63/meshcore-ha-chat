import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

/**
 * Info-icon tooltip — the `ⓘ` button that sits next to a metric label
 * (in hero tiles and in the row's label cell of the sensor table).
 *
 * Per the locked Q7 resolution, threshold-bearing values do NOT use
 * native `title=` attributes. Instead, this component renders a focusable
 * button whose hover, focus, and tap state opens a positioned popover
 * with the band-statement prose and an optional citation footer.
 *
 * Tab-focusable so mobile taps surface the same popover desktop hovers
 * give. The popover positions itself below the icon by default; CSS
 * is overflow-tolerant via max-width: 75vw so it fits narrow viewports.
 *
 * If/when Home Assistant exposes a built-in `<ha-help-tooltip>` component
 * that offers the same data shape (text + optional source) and the same
 * trigger semantics (hover + focus), this component should be replaced
 * with a thin wrapper around that. For now, no such HA primitive exists
 * in this repo's environment, so we render our own.
 */
@customElement('meshcore-info-tip')
export class InfoTip extends LitElement {
  /** Band-statement prose. Plain text; no embedded HTML. */
  @property({ type: String }) content = '';
  /** Optional citation URL. When omitted, no source line renders. */
  @property({ type: String }) source?: string;

  static styles = css`
    :host {
      display: inline-flex;
      vertical-align: middle;
    }
    button.info-tip {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      margin-left: 4px;
      border-radius: 50%;
      color: var(--secondary-text-color);
      background: var(--divider-color, #e0e0e0);
      cursor: help;
      user-select: none;
      flex-shrink: 0;
      border: none;
      padding: 0;
    }
    /* The "i" glyph is drawn as inline SVG (not a Unicode character) so
       its dot + stem sit on the geometric center of the 14×14 button
       regardless of font metrics. Using a Unicode glyph here previously
       produced two stacked, optically-misaligned rings — the CSS-drawn
       button background plus the glyph's own circled-i ring. */
    button.info-tip svg {
      display: block;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    button.info-tip:hover,
    button.info-tip:focus {
      color: var(--card-background-color, #fff);
      background: var(--primary-color, #03a9f4);
      outline: none;
    }
    .info-tip-content {
      position: absolute;
      top: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      display: none;
      width: 260px;
      max-width: 75vw;
      padding: 10px 12px;
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #e0e0e0);
      border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      font-size: 11px;
      font-weight: normal;
      color: var(--primary-text-color);
      text-align: left;
      line-height: 1.45;
      z-index: 100;
      white-space: normal;
      pointer-events: none;
    }
    button.info-tip:hover .info-tip-content,
    button.info-tip:focus .info-tip-content,
    button.info-tip:focus-within .info-tip-content {
      display: block;
    }
    .info-tip-content .src {
      display: block;
      margin-top: 6px;
      font-size: 10px;
      color: var(--secondary-text-color);
      word-break: break-all;
    }
  `;

  render() {
    if (!this.content) return nothing;
    return html`
      <button class="info-tip"
              type="button"
              aria-label="More information"
              @click=${this._stopPropagation}>
        <svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="7" cy="4" r="1.2" fill="currentColor"></circle>
          <rect x="6.1" y="6.2" width="1.8" height="5.2" rx="0.6" fill="currentColor"></rect>
        </svg>
        <span class="info-tip-content" role="tooltip">
          ${this.content}
          ${this.source
            ? html`<span class="src">${this.source}</span>`
            : nothing}
        </span>
      </button>
    `;
  }

  /** Block clicks from bubbling to the parent row's hass-more-info handler. */
  private _stopPropagation(e: Event) {
    e.stopPropagation();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'meshcore-info-tip': InfoTip;
  }
}
