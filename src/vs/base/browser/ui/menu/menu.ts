/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import * as strings from 'vs/base/common/strings';
import { IActionRunner, IAction, SubmenuAction, Separator, IActionViewItemProvider } from 'vs/base/common/actions';
import { ActionBar, ActionsOrientation } from 'vs/base/browser/ui/actionbar/actionbar';
import { ResolvedKeybinding, KeyCode } from 'vs/base/common/keyCodes';
import { addClass, EventType, EventHelper, EventLike, removeTabIndexAndUpdateFocus, isAncestor, hasClass, addDisposableListener, removeClass, append, $, addClasses, removeClasses, clearNode, createStyleSheet, isInShadowDOM, getActiveElement } from 'vs/base/browser/dom';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { RunOnceScheduler } from 'vs/base/common/async';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { Color } from 'vs/base/common/color';
import { DomScrollableElement } from 'vs/base/browser/ui/scrollbar/scrollableElement';
import { ScrollbarVisibility, ScrollEvent } from 'vs/base/common/scrollable';
import { Event } from 'vs/base/common/event';
import { AnchorAlignment } from 'vs/base/browser/ui/contextview/contextview';
import { isLinux, isMacintosh } from 'vs/base/common/platform';
import { Codicon, registerIcon, stripCodicons } from 'vs/base/common/codicons';
import { BaseActionViewItem, ActionViewItem, IActionViewItemOptions } from 'vs/base/browser/ui/actionbar/actionViewItems';
import { formatRule } from 'vs/base/browser/ui/codicons/codiconStyles';

export const MENU_MNEMONIC_REGEX = /\(&([^\s&])\)|(^|[^&])&([^\s&])/;
export const MENU_ESCAPED_MNEMONIC_REGEX = /(&amp;)?(&amp;)([^\s&])/g;

const menuSelectionIcon = registerIcon('menu-selection', Codicon.check);
const menuSubmenuIcon = registerIcon('menu-submenu', Codicon.chevronRight);

export enum Direction {
	Right,
	Left
}

export interface IMenuOptions {
	context?: any;
	actionViewItemProvider?: IActionViewItemProvider;
	actionRunner?: IActionRunner;
	getKeyBinding?: (action: IAction) => ResolvedKeybinding | undefined;
	ariaLabel?: string;
	enableMnemonics?: boolean;
	anchorAlignment?: AnchorAlignment;
	expandDirection?: Direction;
	useEventAsContext?: boolean;
	submenuIds?: Set<string>;
}

export interface IMenuStyles {
	shadowColor?: Color;
	borderColor?: Color;
	foregroundColor?: Color;
	backgroundColor?: Color;
	selectionForegroundColor?: Color;
	selectionBackgroundColor?: Color;
	selectionBorderColor?: Color;
	separatorColor?: Color;
}

interface ISubMenuData {
	parent: Menu;
	submenu?: Menu;
}

export class Menu extends ActionBar {
	private mnemonics: Map<string, Array<BaseMenuActionViewItem>>;
	private readonly menuDisposables: DisposableStore;
	private scrollableElement: DomScrollableElement;
	private menuElement: HTMLElement;
	static globalStyleSheet: HTMLStyleElement;
	protected styleSheet: HTMLStyleElement | undefined;

	constructor(container: HTMLElement, actions: ReadonlyArray<IAction>, options: IMenuOptions = {}) {
		addClass(container, 'monaco-menu-container');
		container.setAttribute('role', 'presentation');
		const menuElement = document.createElement('div');
		addClass(menuElement, 'monaco-menu');
		menuElement.setAttribute('role', 'presentation');

		super(menuElement, {
			orientation: ActionsOrientation.VERTICAL,
			actionViewItemProvider: action => this.doGetActionViewItem(action, options, parentData),
			context: options.context,
			actionRunner: options.actionRunner,
			ariaLabel: options.ariaLabel,
			triggerKeys: { keys: [KeyCode.Enter, ...(isMacintosh || isLinux ? [KeyCode.Space] : [])], keyDown: true }
		});

		this.menuElement = menuElement;

		this.actionsList.setAttribute('role', 'menu');

		this.actionsList.tabIndex = 0;

		this.menuDisposables = this._register(new DisposableStore());

		this.initializeStyleSheet(container);

		addDisposableListener(menuElement, EventType.KEY_DOWN, (e) => {
			const event = new StandardKeyboardEvent(e);

			// Stop tab navigation of menus
			if (event.equals(KeyCode.Tab)) {
				e.preventDefault();
			}
		});

		if (options.enableMnemonics) {
			this.menuDisposables.add(addDisposableListener(menuElement, EventType.KEY_DOWN, (e) => {
				const key = e.key.toLocaleLowerCase();
				if (this.mnemonics.has(key)) {
					EventHelper.stop(e, true);
					const actions = this.mnemonics.get(key)!;

					if (actions.length === 1) {
						if (actions[0] instanceof SubmenuMenuActionViewItem && actions[0].container) {
							this.focusItemByElement(actions[0].container);
						}

						actions[0].onClick(e);
					}

					if (actions.length > 1) {
						const action = actions.shift();
						if (action && action.container) {
							this.focusItemByElement(action.container);
							actions.push(action);
						}

						this.mnemonics.set(key, actions);
					}
				}
			}));
		}

		if (isLinux) {
			this._register(addDisposableListener(menuElement, EventType.KEY_DOWN, e => {
				const event = new StandardKeyboardEvent(e);

				if (event.equals(KeyCode.Home) || event.equals(KeyCode.PageUp)) {
					this.focusedItem = this.viewItems.length - 1;
					this.focusNext();
					EventHelper.stop(e, true);
				} else if (event.equals(KeyCode.End) || event.equals(KeyCode.PageDown)) {
					this.focusedItem = 0;
					this.focusPrevious();
					EventHelper.stop(e, true);
				}
			}));
		}

		this._register(addDisposableListener(this.domNode, EventType.MOUSE_OUT, e => {
			let relatedTarget = e.relatedTarget as HTMLElement;
			if (!isAncestor(relatedTarget, this.domNode)) {
				this.focusedItem = undefined;
				this.updateFocus();
				e.stopPropagation();
			}
		}));

		this._register(addDisposableListener(this.actionsList, EventType.MOUSE_OVER, e => {
			let target = e.target as HTMLElement;
			if (!target || !isAncestor(target, this.actionsList) || target === this.actionsList) {
				return;
			}

			while (target.parentElement !== this.actionsList && target.parentElement !== null) {
				target = target.parentElement;
			}

			if (hasClass(target, 'action-item')) {
				const lastFocusedItem = this.focusedItem;
				this.setFocusedItem(target);

				if (lastFocusedItem !== this.focusedItem) {
					this.updateFocus();
				}
			}
		}));

		let parentData: ISubMenuData = {
			parent: this
		};

		this.mnemonics = new Map<string, Array<BaseMenuActionViewItem>>();

		// Scroll Logic
		this.scrollableElement = this._register(new DomScrollableElement(menuElement, {
			alwaysConsumeMouseWheel: true,
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Visible,
			verticalScrollbarSize: 7,
			handleMouseWheel: true,
			useShadows: true
		}));

		const scrollElement = this.scrollableElement.getDomNode();
		scrollElement.style.position = '';

		this._register(addDisposableListener(scrollElement, EventType.MOUSE_UP, e => {
			// Absorb clicks in menu dead space https://github.com/Microsoft/vscode/issues/63575
			// We do this on the scroll element so the scroll bar doesn't dismiss the menu either
			e.preventDefault();
		}));

		menuElement.style.maxHeight = `${Math.max(10, window.innerHeight - container.getBoundingClientRect().top - 30)}px`;

		actions = actions.filter(a => {
			if (options.submenuIds?.has(a.id)) {
				console.warn(`Found submenu cycle: ${a.id}`);
				return false;
			}

			return true;
		});

		this.push(actions, { icon: true, label: true, isMenu: true });

		container.appendChild(this.scrollableElement.getDomNode());
		this.scrollableElement.scanDomNode();

		this.viewItems.filter(item => !(item instanceof MenuSeparatorActionViewItem)).forEach((item, index, array) => {
			(item as BaseMenuActionViewItem).updatePositionInSet(index + 1, array.length);
		});
	}

	private initializeStyleSheet(container: HTMLElement): void {
		if (isInShadowDOM(container)) {
			this.styleSheet = createStyleSheet(container);
			this.styleSheet.innerHTML = MENU_WIDGET_CSS;
		} else {
			if (!Menu.globalStyleSheet) {
				Menu.globalStyleSheet = createStyleSheet();
				Menu.globalStyleSheet.innerHTML = MENU_WIDGET_CSS;
			}

			this.styleSheet = Menu.globalStyleSheet;
		}
	}

	style(style: IMenuStyles): void {
		const container = this.getContainer();

		const fgColor = style.foregroundColor ? `${style.foregroundColor}` : '';
		const bgColor = style.backgroundColor ? `${style.backgroundColor}` : '';
		const border = style.borderColor ? `1px solid ${style.borderColor}` : '';
		const shadow = style.shadowColor ? `0 2px 4px ${style.shadowColor}` : '';

		container.style.border = border;
		this.domNode.style.color = fgColor;
		this.domNode.style.backgroundColor = bgColor;
		container.style.boxShadow = shadow;

		if (this.viewItems) {
			this.viewItems.forEach(item => {
				if (item instanceof BaseMenuActionViewItem || item instanceof MenuSeparatorActionViewItem) {
					item.style(style);
				}
			});
		}
	}

	getContainer(): HTMLElement {
		return this.scrollableElement.getDomNode();
	}

	get onScroll(): Event<ScrollEvent> {
		return this.scrollableElement.onScroll;
	}

	get scrollOffset(): number {
		return this.menuElement.scrollTop;
	}

	trigger(index: number): void {
		if (index <= this.viewItems.length && index >= 0) {
			const item = this.viewItems[index];
			if (item instanceof SubmenuMenuActionViewItem) {
				super.focus(index);
				item.open(true);
			} else if (item instanceof BaseMenuActionViewItem) {
				super.run(item._action, item._context);
			} else {
				return;
			}
		}
	}

	private focusItemByElement(element: HTMLElement) {
		const lastFocusedItem = this.focusedItem;
		this.setFocusedItem(element);

		if (lastFocusedItem !== this.focusedItem) {
			this.updateFocus();
		}
	}

	private setFocusedItem(element: HTMLElement): void {
		for (let i = 0; i < this.actionsList.children.length; i++) {
			let elem = this.actionsList.children[i];
			if (element === elem) {
				this.focusedItem = i;
				break;
			}
		}
	}

	protected updateFocus(fromRight?: boolean): void {
		super.updateFocus(fromRight, true);

		if (typeof this.focusedItem !== 'undefined') {
			// Workaround for #80047 caused by an issue in chromium
			// https://bugs.chromium.org/p/chromium/issues/detail?id=414283
			// When that's fixed, just call this.scrollableElement.scanDomNode()
			this.scrollableElement.setScrollPosition({
				scrollTop: Math.round(this.menuElement.scrollTop)
			});
		}
	}

	private doGetActionViewItem(action: IAction, options: IMenuOptions, parentData: ISubMenuData): BaseActionViewItem {
		if (action instanceof Separator) {
			return new MenuSeparatorActionViewItem(options.context, action, { icon: true });
		} else if (action instanceof SubmenuAction) {
			const actions = Array.isArray(action.actions) ? action.actions : action.actions();
			const menuActionViewItem = new SubmenuMenuActionViewItem(action, actions, parentData, { ...options, submenuIds: new Set([...(options.submenuIds || []), action.id]) });

			if (options.enableMnemonics) {
				const mnemonic = menuActionViewItem.getMnemonic();
				if (mnemonic && menuActionViewItem.isEnabled()) {
					let actionViewItems: BaseMenuActionViewItem[] = [];
					if (this.mnemonics.has(mnemonic)) {
						actionViewItems = this.mnemonics.get(mnemonic)!;
					}

					actionViewItems.push(menuActionViewItem);

					this.mnemonics.set(mnemonic, actionViewItems);
				}
			}

			return menuActionViewItem;
		} else {
			const menuItemOptions: IMenuItemOptions = { enableMnemonics: options.enableMnemonics, useEventAsContext: options.useEventAsContext };
			if (options.getKeyBinding) {
				const keybinding = options.getKeyBinding(action);
				if (keybinding) {
					const keybindingLabel = keybinding.getLabel();

					if (keybindingLabel) {
						menuItemOptions.keybinding = keybindingLabel;
					}
				}
			}

			const menuActionViewItem = new BaseMenuActionViewItem(options.context, action, menuItemOptions);

			if (options.enableMnemonics) {
				const mnemonic = menuActionViewItem.getMnemonic();
				if (mnemonic && menuActionViewItem.isEnabled()) {
					let actionViewItems: BaseMenuActionViewItem[] = [];
					if (this.mnemonics.has(mnemonic)) {
						actionViewItems = this.mnemonics.get(mnemonic)!;
					}

					actionViewItems.push(menuActionViewItem);

					this.mnemonics.set(mnemonic, actionViewItems);
				}
			}

			return menuActionViewItem;
		}
	}
}

interface IMenuItemOptions extends IActionViewItemOptions {
	enableMnemonics?: boolean;
}

class BaseMenuActionViewItem extends BaseActionViewItem {

	public container: HTMLElement | undefined;

	protected options: IMenuItemOptions;
	protected item: HTMLElement | undefined;

	private runOnceToEnableMouseUp: RunOnceScheduler;
	private label: HTMLElement | undefined;
	private check: HTMLElement | undefined;
	private mnemonic: string | undefined;
	private cssClass: string;
	protected menuStyle: IMenuStyles | undefined;

	constructor(ctx: unknown, action: IAction, options: IMenuItemOptions = {}) {
		options.isMenu = true;
		super(action, action, options);

		this.options = options;
		this.options.icon = options.icon !== undefined ? options.icon : false;
		this.options.label = options.label !== undefined ? options.label : true;
		this.cssClass = '';

		// Set mnemonic
		if (this.options.label && options.enableMnemonics) {
			let label = this.getAction().label;
			if (label) {
				let matches = MENU_MNEMONIC_REGEX.exec(label);
				if (matches) {
					this.mnemonic = (!!matches[1] ? matches[1] : matches[3]).toLocaleLowerCase();
				}
			}
		}

		// Add mouse up listener later to avoid accidental clicks
		this.runOnceToEnableMouseUp = new RunOnceScheduler(() => {
			if (!this.element) {
				return;
			}

			this._register(addDisposableListener(this.element, EventType.MOUSE_UP, e => {
				// removed default prevention as it conflicts
				// with BaseActionViewItem #101537
				// add back if issues arise and link new issue
				EventHelper.stop(e, true);
				this.onClick(e);
			}));
		}, 100);

		this._register(this.runOnceToEnableMouseUp);
	}

	render(container: HTMLElement): void {
		super.render(container);

		if (!this.element) {
			return;
		}

		this.container = container;

		this.item = append(this.element, $('a.action-menu-item'));
		if (this._action.id === Separator.ID) {
			// A separator is a presentation item
			this.item.setAttribute('role', 'presentation');
		} else {
			this.item.setAttribute('role', 'menuitem');
			if (this.mnemonic) {
				this.item.setAttribute('aria-keyshortcuts', `${this.mnemonic}`);
			}
		}

		this.check = append(this.item, $('span.menu-item-check' + menuSelectionIcon.cssSelector));
		this.check.setAttribute('role', 'none');

		this.label = append(this.item, $('span.action-label'));

		if (this.options.label && this.options.keybinding) {
			append(this.item, $('span.keybinding')).textContent = this.options.keybinding;
		}

		// Adds mouse up listener to actually run the action
		this.runOnceToEnableMouseUp.schedule();

		this.updateClass();
		this.updateLabel();
		this.updateTooltip();
		this.updateEnabled();
		this.updateChecked();
	}

	blur(): void {
		super.blur();
		this.applyStyle();
	}

	focus(): void {
		super.focus();

		if (this.item) {
			this.item.focus();
		}

		this.applyStyle();
	}

	updatePositionInSet(pos: number, setSize: number): void {
		if (this.item) {
			this.item.setAttribute('aria-posinset', `${pos}`);
			this.item.setAttribute('aria-setsize', `${setSize}`);
		}
	}

	updateLabel(): void {
		if (!this.label) {
			return;
		}

		if (this.options.label) {
			clearNode(this.label);

			let label = stripCodicons(this.getAction().label);
			if (label) {
				const cleanLabel = cleanMnemonic(label);
				if (!this.options.enableMnemonics) {
					label = cleanLabel;
				}

				this.label.setAttribute('aria-label', cleanLabel.replace(/&&/g, '&'));

				const matches = MENU_MNEMONIC_REGEX.exec(label);

				if (matches) {
					label = strings.escape(label);

					// This is global, reset it
					MENU_ESCAPED_MNEMONIC_REGEX.lastIndex = 0;
					let escMatch = MENU_ESCAPED_MNEMONIC_REGEX.exec(label);

					// We can't use negative lookbehind so if we match our negative and skip
					while (escMatch && escMatch[1]) {
						escMatch = MENU_ESCAPED_MNEMONIC_REGEX.exec(label);
					}

					const replaceDoubleEscapes = (str: string) => str.replace(/&amp;&amp;/g, '&amp;');

					if (escMatch) {
						this.label.append(
							strings.ltrim(replaceDoubleEscapes(label.substr(0, escMatch.index)), ' '),
							$('u', { 'aria-hidden': 'true' },
								escMatch[3]),
							strings.rtrim(replaceDoubleEscapes(label.substr(escMatch.index + escMatch[0].length)), ' '));
					} else {
						this.label.innerText = replaceDoubleEscapes(label).trim();
					}

					if (this.item) {
						this.item.setAttribute('aria-keyshortcuts', (!!matches[1] ? matches[1] : matches[3]).toLocaleLowerCase());
					}
				} else {
					this.label.innerText = label.replace(/&&/g, '&').trim();
				}
			}
		}
	}

	updateTooltip(): void {
		let title: string | null = null;

		if (this.getAction().tooltip) {
			title = this.getAction().tooltip;

		} else if (!this.options.label && this.getAction().label && this.options.icon) {
			title = this.getAction().label;

			if (this.options.keybinding) {
				title = nls.localize({ key: 'titleLabel', comment: ['action title', 'action keybinding'] }, "{0} ({1})", title, this.options.keybinding);
			}
		}

		if (title && this.item) {
			this.item.title = title;
		}
	}

	updateClass(): void {
		if (this.cssClass && this.item) {
			removeClasses(this.item, this.cssClass);
		}
		if (this.options.icon && this.label) {
			this.cssClass = this.getAction().class || '';
			addClass(this.label, 'icon');
			if (this.cssClass) {
				addClasses(this.label, this.cssClass);
			}
			this.updateEnabled();
		} else if (this.label) {
			removeClass(this.label, 'icon');
		}
	}

	updateEnabled(): void {
		if (this.getAction().enabled) {
			if (this.element) {
				removeClass(this.element, 'disabled');
			}

			if (this.item) {
				removeClass(this.item, 'disabled');
				this.item.tabIndex = 0;
			}
		} else {
			if (this.element) {
				addClass(this.element, 'disabled');
			}

			if (this.item) {
				addClass(this.item, 'disabled');
				removeTabIndexAndUpdateFocus(this.item);
			}
		}
	}

	updateChecked(): void {
		if (!this.item) {
			return;
		}

		if (this.getAction().checked) {
			addClass(this.item, 'checked');
			this.item.setAttribute('role', 'menuitemcheckbox');
			this.item.setAttribute('aria-checked', 'true');
		} else {
			removeClass(this.item, 'checked');
			this.item.setAttribute('role', 'menuitem');
			this.item.setAttribute('aria-checked', 'false');
		}
	}

	getMnemonic(): string | undefined {
		return this.mnemonic;
	}

	protected applyStyle(): void {
		if (!this.menuStyle) {
			return;
		}

		const isSelected = this.element && hasClass(this.element, 'focused');
		const fgColor = isSelected && this.menuStyle.selectionForegroundColor ? this.menuStyle.selectionForegroundColor : this.menuStyle.foregroundColor;
		const bgColor = isSelected && this.menuStyle.selectionBackgroundColor ? this.menuStyle.selectionBackgroundColor : undefined;
		const border = isSelected && this.menuStyle.selectionBorderColor ? `thin solid ${this.menuStyle.selectionBorderColor}` : '';

		if (this.item) {
			this.item.style.color = fgColor ? fgColor.toString() : '';
			this.item.style.backgroundColor = bgColor ? bgColor.toString() : '';
		}

		if (this.check) {
			this.check.style.color = fgColor ? fgColor.toString() : '';
		}

		if (this.container) {
			this.container.style.border = border;
		}
	}

	style(style: IMenuStyles): void {
		this.menuStyle = style;
		this.applyStyle();
	}
}

class SubmenuMenuActionViewItem extends BaseMenuActionViewItem {
	private mysubmenu: Menu | null = null;
	private submenuContainer: HTMLElement | undefined;
	private submenuIndicator: HTMLElement | undefined;
	private readonly submenuDisposables = this._register(new DisposableStore());
	private mouseOver: boolean = false;
	private showScheduler: RunOnceScheduler;
	private hideScheduler: RunOnceScheduler;
	private expandDirection: Direction;

	constructor(
		action: IAction,
		private submenuActions: ReadonlyArray<IAction>,
		private parentData: ISubMenuData,
		private submenuOptions?: IMenuOptions
	) {
		super(action, action, submenuOptions);

		this.expandDirection = submenuOptions && submenuOptions.expandDirection !== undefined ? submenuOptions.expandDirection : Direction.Right;

		this.showScheduler = new RunOnceScheduler(() => {
			if (this.mouseOver) {
				this.cleanupExistingSubmenu(false);
				this.createSubmenu(false);
			}
		}, 250);

		this.hideScheduler = new RunOnceScheduler(() => {
			if (this.element && (!isAncestor(getActiveElement(), this.element) && this.parentData.submenu === this.mysubmenu)) {
				this.parentData.parent.focus(false);
				this.cleanupExistingSubmenu(true);
			}
		}, 750);
	}

	render(container: HTMLElement): void {
		super.render(container);

		if (!this.element) {
			return;
		}

		if (this.item) {
			addClass(this.item, 'monaco-submenu-item');
			this.item.setAttribute('aria-haspopup', 'true');
			this.updateAriaExpanded('false');
			this.submenuIndicator = append(this.item, $('span.submenu-indicator' + menuSubmenuIcon.cssSelector));
			this.submenuIndicator.setAttribute('aria-hidden', 'true');
		}

		this._register(addDisposableListener(this.element, EventType.KEY_UP, e => {
			let event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.RightArrow) || event.equals(KeyCode.Enter)) {
				EventHelper.stop(e, true);

				this.createSubmenu(true);
			}
		}));

		this._register(addDisposableListener(this.element, EventType.KEY_DOWN, e => {
			let event = new StandardKeyboardEvent(e);

			if (getActiveElement() === this.item) {
				if (event.equals(KeyCode.RightArrow) || event.equals(KeyCode.Enter)) {
					EventHelper.stop(e, true);
				}
			}
		}));

		this._register(addDisposableListener(this.element, EventType.MOUSE_OVER, e => {
			if (!this.mouseOver) {
				this.mouseOver = true;

				this.showScheduler.schedule();
			}
		}));

		this._register(addDisposableListener(this.element, EventType.MOUSE_LEAVE, e => {
			this.mouseOver = false;
		}));

		this._register(addDisposableListener(this.element, EventType.FOCUS_OUT, e => {
			if (this.element && !isAncestor(getActiveElement(), this.element)) {
				this.hideScheduler.schedule();
			}
		}));

		this._register(this.parentData.parent.onScroll(() => {
			this.parentData.parent.focus(false);
			this.cleanupExistingSubmenu(false);
		}));
	}

	open(selectFirst?: boolean): void {
		this.cleanupExistingSubmenu(false);
		this.createSubmenu(selectFirst);
	}

	onClick(e: EventLike): void {
		// stop clicking from trying to run an action
		EventHelper.stop(e, true);

		this.cleanupExistingSubmenu(false);
		this.createSubmenu(true);
	}

	private cleanupExistingSubmenu(force: boolean): void {
		if (this.parentData.submenu && (force || (this.parentData.submenu !== this.mysubmenu))) {
			this.parentData.submenu.dispose();
			this.parentData.submenu = undefined;
			this.updateAriaExpanded('false');
			if (this.submenuContainer) {
				this.submenuDisposables.clear();
				this.submenuContainer = undefined;
			}
		}
	}

	private createSubmenu(selectFirstItem = true): void {
		if (!this.element) {
			return;
		}

		if (!this.parentData.submenu) {
			this.updateAriaExpanded('true');
			this.submenuContainer = append(this.element, $('div.monaco-submenu'));
			addClasses(this.submenuContainer, 'menubar-menu-items-holder', 'context-view');

			// Set the top value of the menu container before construction
			// This allows the menu constructor to calculate the proper max height
			const computedStyles = getComputedStyle(this.parentData.parent.domNode);
			const paddingTop = parseFloat(computedStyles.paddingTop || '0') || 0;
			this.submenuContainer.style.top = `${this.element.offsetTop - this.parentData.parent.scrollOffset - paddingTop}px`;

			this.parentData.submenu = new Menu(this.submenuContainer, this.submenuActions, this.submenuOptions);
			if (this.menuStyle) {
				this.parentData.submenu.style(this.menuStyle);
			}

			const boundingRect = this.element.getBoundingClientRect();
			const childBoundingRect = this.submenuContainer.getBoundingClientRect();

			if (this.expandDirection === Direction.Right) {
				if (window.innerWidth <= boundingRect.right + childBoundingRect.width) {
					this.submenuContainer.style.left = '10px';
					this.submenuContainer.style.top = `${this.element.offsetTop - this.parentData.parent.scrollOffset + boundingRect.height}px`;
				} else {
					this.submenuContainer.style.left = `${this.element.offsetWidth}px`;
					this.submenuContainer.style.top = `${this.element.offsetTop - this.parentData.parent.scrollOffset - paddingTop}px`;
				}
			} else if (this.expandDirection === Direction.Left) {
				this.submenuContainer.style.right = `${this.element.offsetWidth}px`;
				this.submenuContainer.style.left = 'auto';
				this.submenuContainer.style.top = `${this.element.offsetTop - this.parentData.parent.scrollOffset - paddingTop}px`;
			}

			this.submenuDisposables.add(addDisposableListener(this.submenuContainer, EventType.KEY_UP, e => {
				let event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.LeftArrow)) {
					EventHelper.stop(e, true);

					this.parentData.parent.focus();

					this.cleanupExistingSubmenu(true);
				}
			}));

			this.submenuDisposables.add(addDisposableListener(this.submenuContainer, EventType.KEY_DOWN, e => {
				let event = new StandardKeyboardEvent(e);
				if (event.equals(KeyCode.LeftArrow)) {
					EventHelper.stop(e, true);
				}
			}));


			this.submenuDisposables.add(this.parentData.submenu.onDidCancel(() => {
				this.parentData.parent.focus();

				this.cleanupExistingSubmenu(true);
			}));

			this.parentData.submenu.focus(selectFirstItem);

			this.mysubmenu = this.parentData.submenu;
		} else {
			this.parentData.submenu.focus(false);
		}
	}

	private updateAriaExpanded(value: string): void {
		if (this.item) {
			this.item?.setAttribute('aria-expanded', value);
		}
	}

	protected applyStyle(): void {
		super.applyStyle();

		if (!this.menuStyle) {
			return;
		}

		const isSelected = this.element && hasClass(this.element, 'focused');
		const fgColor = isSelected && this.menuStyle.selectionForegroundColor ? this.menuStyle.selectionForegroundColor : this.menuStyle.foregroundColor;

		if (this.submenuIndicator) {
			this.submenuIndicator.style.color = fgColor ? `${fgColor}` : '';
		}

		if (this.parentData.submenu) {
			this.parentData.submenu.style(this.menuStyle);
		}
	}

	dispose(): void {
		super.dispose();

		this.hideScheduler.dispose();

		if (this.mysubmenu) {
			this.mysubmenu.dispose();
			this.mysubmenu = null;
		}

		if (this.submenuContainer) {
			this.submenuContainer = undefined;
		}
	}
}

class MenuSeparatorActionViewItem extends ActionViewItem {
	style(style: IMenuStyles): void {
		if (this.label) {
			this.label.style.borderBottomColor = style.separatorColor ? `${style.separatorColor}` : '';
		}
	}
}

export function cleanMnemonic(label: string): string {
	const regex = MENU_MNEMONIC_REGEX;

	const matches = regex.exec(label);
	if (!matches) {
		return label;
	}

	const mnemonicInText = !matches[1];

	return label.replace(regex, mnemonicInText ? '$2$3' : '').trim();
}

let MENU_WIDGET_CSS: string = /* css */`
.monaco-menu {
	font-size: 13px;

}

${formatRule(menuSelectionIcon)}
${formatRule(menuSubmenuIcon)}

.monaco-action-bar {
	text-align: right;
	overflow: hidden;
	white-space: nowrap;
}

.monaco-action-bar .actions-container {
	display: flex;
	margin: 0 auto;
	padding: 0;
	width: 100%;
	justify-content: flex-end;
}

.monaco-action-bar.vertical .actions-container {
	display: inline-block;
}

.monaco-action-bar.reverse .actions-container {
	flex-direction: row-reverse;
}

.monaco-action-bar .action-item {
	cursor: pointer;
	display: inline-block;
	transition: transform 50ms ease;
	position: relative;  /* DO NOT REMOVE - this is the key to preventing the ghosting icon bug in Chrome 42 */
}

.monaco-action-bar .action-item.disabled {
	cursor: default;
}

.monaco-action-bar.animated .action-item.active {
	transform: scale(1.272019649, 1.272019649); /* 1.272019649 = √φ */
}

.monaco-action-bar .action-item .icon,
.monaco-action-bar .action-item .codicon {
	display: inline-block;
}

.monaco-action-bar .action-item .codicon {
	display: flex;
	align-items: center;
}

.monaco-action-bar .action-label {
	font-size: 11px;
	margin-right: 4px;
}

.monaco-action-bar .action-item.disabled .action-label,
.monaco-action-bar .action-item.disabled .action-label:hover {
	opacity: 0.4;
}

/* Vertical actions */

.monaco-action-bar.vertical {
	text-align: left;
}

.monaco-action-bar.vertical .action-item {
	display: block;
}

.monaco-action-bar.vertical .action-label.separator {
	display: block;
	border-bottom: 1px solid #bbb;
	padding-top: 1px;
	margin-left: .8em;
	margin-right: .8em;
}

.monaco-action-bar.animated.vertical .action-item.active {
	transform: translate(5px, 0);
}

.secondary-actions .monaco-action-bar .action-label {
	margin-left: 6px;
}

/* Action Items */
.monaco-action-bar .action-item.select-container {
	overflow: hidden; /* somehow the dropdown overflows its container, we prevent it here to not push */
	flex: 1;
	max-width: 170px;
	min-width: 60px;
	display: flex;
	align-items: center;
	justify-content: center;
	margin-right: 10px;
}

.monaco-menu .monaco-action-bar.vertical {
	margin-left: 0;
	overflow: visible;
}

.monaco-menu .monaco-action-bar.vertical .actions-container {
	display: block;
}

.monaco-menu .monaco-action-bar.vertical .action-item {
	padding: 0;
	transform: none;
	display: flex;
}

.monaco-menu .monaco-action-bar.vertical .action-item.active {
	transform: none;
}

.monaco-menu .monaco-action-bar.vertical .action-menu-item {
	flex: 1 1 auto;
	display: flex;
	height: 2em;
	align-items: center;
	position: relative;
}

.monaco-menu .monaco-action-bar.vertical .action-label {
	flex: 1 1 auto;
	text-decoration: none;
	padding: 0 1em;
	background: none;
	font-size: 12px;
	line-height: 1;
}

.monaco-menu .monaco-action-bar.vertical .keybinding,
.monaco-menu .monaco-action-bar.vertical .submenu-indicator {
	display: inline-block;
	flex: 2 1 auto;
	padding: 0 1em;
	text-align: right;
	font-size: 12px;
	line-height: 1;
}

.monaco-menu .monaco-action-bar.vertical .submenu-indicator {
	height: 100%;
}

.monaco-menu .monaco-action-bar.vertical .submenu-indicator.codicon {
	font-size: 16px !important;
	display: flex;
	align-items: center;
}

.monaco-menu .monaco-action-bar.vertical .submenu-indicator.codicon::before {
	margin-left: auto;
	margin-right: -20px;
}

.monaco-menu .monaco-action-bar.vertical .action-item.disabled .keybinding,
.monaco-menu .monaco-action-bar.vertical .action-item.disabled .submenu-indicator {
	opacity: 0.4;
}

.monaco-menu .monaco-action-bar.vertical .action-label:not(.separator) {
	display: inline-block;
	box-sizing: border-box;
	margin: 0;
}

.monaco-menu .monaco-action-bar.vertical .action-item {
	position: static;
	overflow: visible;
}

.monaco-menu .monaco-action-bar.vertical .action-item .monaco-submenu {
	position: absolute;
}

.monaco-menu .monaco-action-bar.vertical .action-label.separator {
	padding: 0.5em 0 0 0;
	margin-bottom: 0.5em;
	width: 100%;
	height: 0px !important;
	margin-left: .8em !important;
	margin-right: .8em !important;
}

.monaco-menu .monaco-action-bar.vertical .action-label.separator.text {
	padding: 0.7em 1em 0.1em 1em;
	font-weight: bold;
	opacity: 1;
}

.monaco-menu .monaco-action-bar.vertical .action-label:hover {
	color: inherit;
}

.monaco-menu .monaco-action-bar.vertical .menu-item-check {
	position: absolute;
	visibility: hidden;
	width: 1em;
	height: 100%;
}

.monaco-menu .monaco-action-bar.vertical .action-menu-item.checked .menu-item-check {
	visibility: visible;
	display: flex;
	align-items: center;
	justify-content: center;
}

/* Context Menu */

.context-view.monaco-menu-container {
	outline: 0;
	border: none;
	animation: fadeIn 0.083s linear;
}

.context-view.monaco-menu-container :focus,
.context-view.monaco-menu-container .monaco-action-bar.vertical:focus,
.context-view.monaco-menu-container .monaco-action-bar.vertical :focus {
	outline: 0;
}

.monaco-menu .monaco-action-bar.vertical .action-item {
	border: thin solid transparent; /* prevents jumping behaviour on hover or focus */
}


/* High Contrast Theming */
.hc-black .context-view.monaco-menu-container {
	box-shadow: none;
}

.hc-black .monaco-menu .monaco-action-bar.vertical .action-item.focused {
	background: none;
}

/* Vertical Action Bar Styles */

.monaco-menu .monaco-action-bar.vertical {
	padding: .5em 0;
}

.monaco-menu .monaco-action-bar.vertical .action-menu-item {
	height: 1.8em;
}

.monaco-menu .monaco-action-bar.vertical .action-label:not(.separator),
.monaco-menu .monaco-action-bar.vertical .keybinding {
	font-size: inherit;
	padding: 0 2em;
}

.monaco-menu .monaco-action-bar.vertical .menu-item-check {
	font-size: inherit;
	width: 2em;
}

.monaco-menu .monaco-action-bar.vertical .action-label.separator {
	font-size: inherit;
	padding: 0.2em 0 0 0;
	margin-bottom: 0.2em;
}

linux .monaco-menu .monaco-action-bar.vertical .action-label.separator {
	margin-left: 0;
	margin-right: 0;
}

.monaco-menu .monaco-action-bar.vertical .submenu-indicator {
	font-size: 60%;
	padding: 0 1.8em;
}

:host-context(.linux) .monaco-menu .monaco-action-bar.vertical .submenu-indicator {
	height: 100%;
	mask-size: 10px 10px;
	-webkit-mask-size: 10px 10px;
}

.monaco-menu .action-item {
	cursor: default;
}

`;
