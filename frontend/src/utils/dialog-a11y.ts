/**
 * Dialog accessibility helper — focus trap + Escape-to-close.
 *
 * Phase 5 of the HA Quality + Best Practices Remediation (Q13). The same
 * pattern is needed by every modal dialog component in
 * `frontend/src/components/`, so it is implemented once as a Lit
 * ReactiveController and adopted with a one-line constructor call.
 *
 * Usage:
 *
 * ```ts
 * import { attachDialogA11y } from '../utils/dialog-a11y';
 *
 * @customElement('meshcore-some-dialog')
 * export class SomeDialog extends LitElement {
 *   @property({ type: Boolean }) open = false;
 *
 *   constructor() {
 *     super();
 *     attachDialogA11y(this, {
 *       isOpen: () => this.open,
 *       onEscape: () => this._close(),
 *     });
 *   }
 *
 *   private _close() {
 *     this.open = false;
 *     this.dispatchEvent(new CustomEvent('close', { bubbles: true }));
 *   }
 * }
 * ```
 *
 * The `attachDialogA11y` helper is preferred over storing the controller
 * reference because Lit's host.addController side effect is the only
 * thing callers need — the returned reference would be unused and trip
 * `noUnusedLocals`.
 *
 * Behavior:
 *
 *   - When `isOpen()` transitions from false to true, focus moves to the
 *     first focusable descendant inside the host's shadow root.
 *   - Tab from the last focusable wraps to the first; Shift+Tab from the
 *     first wraps to the last. Focus stays inside the dialog.
 *   - Escape calls `onEscape()` and stops propagation so a wrapping
 *     dialog (e.g., a confirm sheet inside a manage dialog) does not
 *     also close.
 *   - When the dialog closes, focus is restored to the element that was
 *     focused before it opened, when that element is still in the DOM.
 *
 * Notes:
 *
 *   - The keydown listener is registered on the host element. Events
 *     from the shadow root bubble through the host before reaching
 *     light-DOM ancestors, so this single registration covers every
 *     focusable descendant.
 *   - `shadowRoot.activeElement` is used (not `document.activeElement`)
 *     to identify the focused descendant; `document.activeElement`
 *     returns the host itself across the shadow boundary.
 *   - Components whose `:host` uses `display: contents` (so the host
 *     does not render a real box) still work — the keydown listener is
 *     on the host element, not on a layout box.
 */

import type { ReactiveController, ReactiveControllerHost } from 'lit';

/** CSS selector matching elements that participate in the Tab order. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogA11yOptions {
  /** Predicate returning true when the dialog is currently open. */
  isOpen: () => boolean;
  /** Called when the user presses Escape inside the open dialog. */
  onEscape: () => void;
  /**
   * Optional focusable-scope override. Defaults to the host's shadow
   * root. Override only if the dialog renders into a portal or light DOM.
   */
  getScope?: () => ParentNode | null;
}

type Host = ReactiveControllerHost & HTMLElement;

export class DialogA11yController implements ReactiveController {
  private _wasOpen = false;
  private _previousActive: Element | null = null;

  constructor(private host: Host, private opts: DialogA11yOptions) {
    this.host.addController(this);
  }

  hostConnected(): void {
    this.host.addEventListener('keydown', this._onKeyDown);
  }

  hostDisconnected(): void {
    this.host.removeEventListener('keydown', this._onKeyDown);
    // If the host vanishes mid-open, drop the captured reference so we
    // don't leak DOM nodes.
    this._previousActive = null;
  }

  hostUpdated(): void {
    const open = this.opts.isOpen();
    if (open && !this._wasOpen) {
      // Just opened — capture prior focus and focus the first item.
      this._previousActive = this._currentDocumentActive();
      this._focusFirstSoon();
    } else if (!open && this._wasOpen) {
      // Just closed — restore prior focus when the previous element is
      // still in the document and focusable.
      const prev = this._previousActive as HTMLElement | null;
      this._previousActive = null;
      if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try {
          prev.focus();
        } catch {
          /* ignore */
        }
      }
    }
    this._wasOpen = open;
  }

  /** Focusable descendants in DOM order (visible only). */
  private _getFocusables(): HTMLElement[] {
    const scope = this.opts.getScope?.() ?? this.host.shadowRoot;
    if (!scope) return [];
    return Array.from(
      scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => {
      // `offsetParent === null` skips display:none / hidden ancestors.
      // Inputs inside a closed `<details>` etc. would also be skipped.
      if (el.hasAttribute('aria-hidden')) return false;
      if (el.hidden) return false;
      // `offsetParent` is null for fixed-position elements too — fall
      // back to a getClientRects() check in that case.
      if (el.offsetParent === null && el.getClientRects().length === 0) {
        return false;
      }
      return true;
    });
  }

  private _focusFirstSoon(): void {
    // Wait one microtask so Lit has finished rendering the open state.
    queueMicrotask(() => {
      if (!this.opts.isOpen()) return;
      // If focus is already inside the dialog (e.g., the user clicked an
      // item that opened it via .focus()), respect that and don't move.
      const inside = this.host.shadowRoot?.activeElement;
      if (inside) return;
      const items = this._getFocusables();
      if (items.length === 0) return;
      try {
        items[0].focus();
      } catch {
        /* ignore */
      }
    });
  }

  private _currentDocumentActive(): Element | null {
    let active = document.activeElement;
    // Walk into shadow roots to find the leaf-most focused element so
    // we can restore focus accurately on close.
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  private _onKeyDown = (e: KeyboardEvent): void => {
    if (!this.opts.isOpen()) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.opts.onEscape();
      return;
    }

    if (e.key !== 'Tab') return;

    const items = this._getFocusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.host.shadowRoot?.activeElement as HTMLElement | null;

    // No focused descendant yet — pull focus into the dialog.
    if (!active || !this.host.shadowRoot?.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }

    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/**
 * Attach a {@link DialogA11yController} to a host as a side effect.
 *
 * Equivalent to `new DialogA11yController(host, opts)` but doesn't
 * return the instance, so callers don't need to store an unused field
 * (which trips `noUnusedLocals`).
 */
export function attachDialogA11y(
  host: ReactiveControllerHost & HTMLElement,
  opts: DialogA11yOptions,
): void {
  // eslint-disable-next-line @typescript-eslint/no-new
  new DialogA11yController(host, opts);
}
