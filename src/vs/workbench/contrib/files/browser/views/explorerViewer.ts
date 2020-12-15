/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IListAccessibilityProvider } from 'vs/base/browser/ui/list/listWidget';
import * as DOM from 'vs/base/browser/dom';
import * as glob from 'vs/base/common/glob';
import { IListVirtualDelegate, ListDragOverEffect } from 'vs/base/browser/ui/list/list';
import { IProgressService, ProgressLocation, IProgressStep, IProgress } from 'vs/platform/progress/common/progress';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IFileService, FileKind, FileOperationError, FileOperationResult, FileSystemProviderCapabilities, BinarySize } from 'vs/platform/files/common/files';
import { IWorkbenchLayoutService } from 'vs/workbench/services/layout/browser/layoutService';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IDisposable, Disposable, dispose, toDisposable, DisposableStore } from 'vs/base/common/lifecycle';
import { KeyCode } from 'vs/base/common/keyCodes';
import { IFileLabelOptions, IResourceLabel, ResourceLabels } from 'vs/workbench/browser/labels';
import { ITreeNode, ITreeFilter, TreeVisibility, TreeFilterResult, IAsyncDataSource, ITreeSorter, ITreeDragAndDrop, ITreeDragOverReaction, TreeDragOverBubble } from 'vs/base/browser/ui/tree/tree';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IConfigurationService, ConfigurationTarget } from 'vs/platform/configuration/common/configuration';
import { IFilesConfiguration, IExplorerService, VIEW_ID } from 'vs/workbench/contrib/files/common/files';
import { dirname, joinPath, isEqualOrParent, basename, distinctParents } from 'vs/base/common/resources';
import { InputBox, MessageType } from 'vs/base/browser/ui/inputbox/inputBox';
import { localize } from 'vs/nls';
import { attachInputBoxStyler } from 'vs/platform/theme/common/styler';
import { once } from 'vs/base/common/functional';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { equals, deepClone } from 'vs/base/common/objects';
import * as path from 'vs/base/common/path';
import { ExplorerItem, NewExplorerItem } from 'vs/workbench/contrib/files/common/explorerModel';
import { compareFileExtensionsNumeric, compareFileNamesNumeric } from 'vs/base/common/comparers';
import { fillResourceDataTransfers, CodeDataTransfers, extractResources, containsDragType } from 'vs/workbench/browser/dnd';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IDragAndDropData, DataTransfers } from 'vs/base/browser/dnd';
import { Schemas } from 'vs/base/common/network';
import { DesktopDragAndDropData, ExternalElementsDragAndDropData, ElementsDragAndDropData } from 'vs/base/browser/ui/list/listView';
import { isMacintosh, isWeb } from 'vs/base/common/platform';
import { IDialogService, IConfirmation, getFileNamesMessage } from 'vs/platform/dialogs/common/dialogs';
import { IWorkingCopyFileService } from 'vs/workbench/services/workingCopy/common/workingCopyFileService';
import { IHostService } from 'vs/workbench/services/host/browser/host';
import { IWorkspaceEditingService } from 'vs/workbench/services/workspaces/common/workspaceEditing';
import { URI } from 'vs/base/common/uri';
import { ITask, sequence } from 'vs/base/common/async';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IWorkspaceFolderCreationData } from 'vs/platform/workspaces/common/workspaces';
import { findValidPasteFileTarget } from 'vs/workbench/contrib/files/browser/fileActions';
import { FuzzyScore, createMatches } from 'vs/base/common/filters';
import { Emitter, Event, EventMultiplexer } from 'vs/base/common/event';
import { ITreeCompressionDelegate } from 'vs/base/browser/ui/tree/asyncDataTree';
import { ICompressibleTreeRenderer } from 'vs/base/browser/ui/tree/objectTree';
import { ICompressedTreeNode } from 'vs/base/browser/ui/tree/compressedObjectTreeModel';
import { VSBuffer, newWriteableBufferStream } from 'vs/base/common/buffer';
import { ILabelService } from 'vs/platform/label/common/label';
import { isNumber } from 'vs/base/common/types';
import { domEvent } from 'vs/base/browser/event';
import { IEditableData } from 'vs/workbench/common/views';
import { IEditorInput } from 'vs/workbench/common/editor';
import { CancellationTokenSource, CancellationToken } from 'vs/base/common/cancellation';

export class ExplorerDelegate implements IListVirtualDelegate<ExplorerItem> {

	static readonly ITEM_HEIGHT = 22;

	getHeight(element: ExplorerItem): number {
		return ExplorerDelegate.ITEM_HEIGHT;
	}

	getTemplateId(element: ExplorerItem): string {
		return FilesRenderer.ID;
	}
}

export const explorerRootErrorEmitter = new Emitter<URI>();
export class ExplorerDataSource implements IAsyncDataSource<ExplorerItem | ExplorerItem[], ExplorerItem> {

	constructor(
		@IProgressService private readonly progressService: IProgressService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IFileService private readonly fileService: IFileService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService
	) { }

	hasChildren(element: ExplorerItem | ExplorerItem[]): boolean {
		return Array.isArray(element) || element.isDirectory;
	}

	getChildren(element: ExplorerItem | ExplorerItem[]): Promise<ExplorerItem[]> {
		if (Array.isArray(element)) {
			return Promise.resolve(element);
		}

		const sortOrder = this.explorerService.sortOrder;
		const promise = element.fetchChildren(sortOrder).then(undefined, e => {

			if (element instanceof ExplorerItem && element.isRoot) {
				if (this.contextService.getWorkbenchState() === WorkbenchState.FOLDER) {
					// Single folder create a dummy explorer item to show error
					const placeholder = new ExplorerItem(element.resource, this.fileService, undefined, false);
					placeholder.isError = true;
					return [placeholder];
				} else {
					explorerRootErrorEmitter.fire(element.resource);
				}
			} else {
				// Do not show error for roots since we already use an explorer decoration to notify user
				this.notificationService.error(e);
			}

			return []; // we could not resolve any children because of an error
		});

		this.progressService.withProgress({
			location: ProgressLocation.Explorer,
			delay: this.layoutService.isRestored() ? 800 : 1200 // less ugly initial startup
		}, _progress => promise);

		return promise;
	}
}

export interface ICompressedNavigationController {
	readonly current: ExplorerItem;
	readonly currentId: string;
	readonly items: ExplorerItem[];
	readonly labels: HTMLElement[];
	readonly index: number;
	readonly count: number;
	readonly onDidChange: Event<void>;
	previous(): void;
	next(): void;
	first(): void;
	last(): void;
	setIndex(index: number): void;
	updateCollapsed(collapsed: boolean): void;
}

export class CompressedNavigationController implements ICompressedNavigationController, IDisposable {

	static ID = 0;

	private _index: number;
	private _labels!: HTMLElement[];
	private _updateLabelDisposable: IDisposable;

	get index(): number { return this._index; }
	get count(): number { return this.items.length; }
	get current(): ExplorerItem { return this.items[this._index]!; }
	get currentId(): string { return `${this.id}_${this.index}`; }
	get labels(): HTMLElement[] { return this._labels; }

	private _onDidChange = new Emitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private id: string, readonly items: ExplorerItem[], templateData: IFileTemplateData, private depth: number, private collapsed: boolean) {
		this._index = items.length - 1;

		this.updateLabels(templateData);
		this._updateLabelDisposable = templateData.label.onDidRender(() => this.updateLabels(templateData));
	}

	private updateLabels(templateData: IFileTemplateData): void {
		this._labels = Array.from(templateData.container.querySelectorAll('.label-name')) as HTMLElement[];

		for (let i = 0; i < this.labels.length; i++) {
			this.labels[i].setAttribute('aria-label', this.items[i].name);
			this.labels[i].setAttribute('aria-level', `${this.depth + i}`);
		}
		this.updateCollapsed(this.collapsed);

		if (this._index < this.labels.length) {
			DOM.addClass(this.labels[this._index], 'active');
		}
	}

	previous(): void {
		if (this._index <= 0) {
			return;
		}

		this.setIndex(this._index - 1);
	}

	next(): void {
		if (this._index >= this.items.length - 1) {
			return;
		}

		this.setIndex(this._index + 1);
	}

	first(): void {
		if (this._index === 0) {
			return;
		}

		this.setIndex(0);
	}

	last(): void {
		if (this._index === this.items.length - 1) {
			return;
		}

		this.setIndex(this.items.length - 1);
	}

	setIndex(index: number): void {
		if (index < 0 || index >= this.items.length) {
			return;
		}

		DOM.removeClass(this.labels[this._index], 'active');
		this._index = index;
		DOM.addClass(this.labels[this._index], 'active');

		this._onDidChange.fire();
	}

	updateCollapsed(collapsed: boolean): void {
		this.collapsed = collapsed;
		for (let i = 0; i < this.labels.length; i++) {
			this.labels[i].setAttribute('aria-expanded', collapsed ? 'false' : 'true');
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._updateLabelDisposable.dispose();
	}
}

export interface IFileTemplateData {
	elementDisposable: IDisposable;
	label: IResourceLabel;
	container: HTMLElement;
}

export class FilesRenderer implements ICompressibleTreeRenderer<ExplorerItem, FuzzyScore, IFileTemplateData>, IListAccessibilityProvider<ExplorerItem>, IDisposable {
	static readonly ID = 'file';

	private config: IFilesConfiguration;
	private configListener: IDisposable;
	private compressedNavigationControllers = new Map<ExplorerItem, CompressedNavigationController>();

	private _onDidChangeActiveDescendant = new EventMultiplexer<void>();
	readonly onDidChangeActiveDescendant = this._onDidChangeActiveDescendant.event;

	constructor(
		private labels: ResourceLabels,
		private updateWidth: (stat: ExplorerItem) => void,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IThemeService private readonly themeService: IThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@ILabelService private readonly labelService: ILabelService
	) {
		this.config = this.configurationService.getValue<IFilesConfiguration>();
		this.configListener = this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('explorer')) {
				this.config = this.configurationService.getValue();
			}
		});
	}

	getWidgetAriaLabel(): string {
		return localize('treeAriaLabel', "Files Explorer");
	}

	get templateId(): string {
		return FilesRenderer.ID;
	}

	renderTemplate(container: HTMLElement): IFileTemplateData {
		const elementDisposable = Disposable.None;
		const label = this.labels.create(container, { supportHighlights: true });

		return { elementDisposable, label, container };
	}

	renderElement(node: ITreeNode<ExplorerItem, FuzzyScore>, index: number, templateData: IFileTemplateData): void {
		templateData.elementDisposable.dispose();
		const stat = node.element;
		const editableData = this.explorerService.getEditableData(stat);

		DOM.removeClass(templateData.label.element, 'compressed');

		// File Label
		if (!editableData) {
			templateData.label.element.style.display = 'flex';
			templateData.elementDisposable = this.renderStat(stat, stat.name, undefined, node.filterData, templateData);
		}

		// Input Box
		else {
			templateData.label.element.style.display = 'none';
			templateData.elementDisposable = this.renderInputBox(templateData.container, stat, editableData);
		}
	}

	renderCompressedElements(node: ITreeNode<ICompressedTreeNode<ExplorerItem>, FuzzyScore>, index: number, templateData: IFileTemplateData, height: number | undefined): void {
		templateData.elementDisposable.dispose();

		const stat = node.element.elements[node.element.elements.length - 1];
		const editable = node.element.elements.filter(e => this.explorerService.isEditable(e));
		const editableData = editable.length === 0 ? undefined : this.explorerService.getEditableData(editable[0]);

		// File Label
		if (!editableData) {
			DOM.addClass(templateData.label.element, 'compressed');
			templateData.label.element.style.display = 'flex';

			const disposables = new DisposableStore();
			const id = `compressed-explorer_${CompressedNavigationController.ID++}`;

			const label = node.element.elements.map(e => e.name);
			disposables.add(this.renderStat(stat, label, id, node.filterData, templateData));

			const compressedNavigationController = new CompressedNavigationController(id, node.element.elements, templateData, node.depth, node.collapsed);
			disposables.add(compressedNavigationController);
			this.compressedNavigationControllers.set(stat, compressedNavigationController);

			// accessibility
			disposables.add(this._onDidChangeActiveDescendant.add(compressedNavigationController.onDidChange));

			domEvent(templateData.container, 'mousedown')(e => {
				const result = getIconLabelNameFromHTMLElement(e.target);

				if (result) {
					compressedNavigationController.setIndex(result.index);
				}
			}, undefined, disposables);

			disposables.add(toDisposable(() => this.compressedNavigationControllers.delete(stat)));

			templateData.elementDisposable = disposables;
		}

		// Input Box
		else {
			DOM.removeClass(templateData.label.element, 'compressed');
			templateData.label.element.style.display = 'none';
			templateData.elementDisposable = this.renderInputBox(templateData.container, editable[0], editableData);
		}
	}

	private renderStat(stat: ExplorerItem, label: string | string[], domId: string | undefined, filterData: FuzzyScore | undefined, templateData: IFileTemplateData): IDisposable {
		templateData.label.element.style.display = 'flex';
		const extraClasses = ['explorer-item'];
		if (this.explorerService.isCut(stat)) {
			extraClasses.push('cut');
		}

		templateData.label.setResource({ resource: stat.resource, name: label }, {
			fileKind: stat.isRoot ? FileKind.ROOT_FOLDER : stat.isDirectory ? FileKind.FOLDER : FileKind.FILE,
			extraClasses,
			fileDecorations: this.config.explorer.decorations,
			matches: createMatches(filterData),
			separator: this.labelService.getSeparator(stat.resource.scheme, stat.resource.authority),
			domId
		});

		return templateData.label.onDidRender(() => {
			try {
				this.updateWidth(stat);
			} catch (e) {
				// noop since the element might no longer be in the tree, no update of width necessery
			}
		});
	}

	private renderInputBox(container: HTMLElement, stat: ExplorerItem, editableData: IEditableData): IDisposable {

		// Use a file label only for the icon next to the input box
		const label = this.labels.create(container);
		const extraClasses = ['explorer-item', 'explorer-item-edited'];
		const fileKind = stat.isRoot ? FileKind.ROOT_FOLDER : stat.isDirectory ? FileKind.FOLDER : FileKind.FILE;
		const labelOptions: IFileLabelOptions = { hidePath: true, hideLabel: true, fileKind, extraClasses };

		const parent = stat.name ? dirname(stat.resource) : stat.resource;
		const value = stat.name || '';

		label.setFile(joinPath(parent, value || ' '), labelOptions); // Use icon for ' ' if name is empty.

		// hack: hide label
		(label.element.firstElementChild as HTMLElement).style.display = 'none';

		// Input field for name
		const inputBox = new InputBox(label.element, this.contextViewService, {
			validationOptions: {
				validation: (value) => {
					const message = editableData.validationMessage(value);
					if (!message || message.severity !== Severity.Error) {
						return null;
					}

					return {
						content: message.content,
						formatContent: true,
						type: MessageType.ERROR
					};
				}
			},
			ariaLabel: localize('fileInputAriaLabel', "Type file name. Press Enter to confirm or Escape to cancel.")
		});
		const styler = attachInputBoxStyler(inputBox, this.themeService);

		const lastDot = value.lastIndexOf('.');

		inputBox.value = value;
		inputBox.focus();
		inputBox.select({ start: 0, end: lastDot > 0 && !stat.isDirectory ? lastDot : value.length });

		const done = once((success: boolean, finishEditing: boolean) => {
			label.element.style.display = 'none';
			const value = inputBox.value;
			dispose(toDispose);
			label.element.remove();
			if (finishEditing) {
				editableData.onFinish(value, success);
			}
		});

		const showInputBoxNotification = () => {
			if (inputBox.isInputValid()) {
				const message = editableData.validationMessage(inputBox.value);
				if (message) {
					inputBox.showMessage({
						content: message.content,
						formatContent: true,
						type: message.severity === Severity.Info ? MessageType.INFO : message.severity === Severity.Warning ? MessageType.WARNING : MessageType.ERROR
					});
				} else {
					inputBox.hideMessage();
				}
			}
		};
		showInputBoxNotification();

		const toDispose = [
			inputBox,
			inputBox.onDidChange(value => {
				label.setFile(joinPath(parent, value || ' '), labelOptions); // update label icon while typing!
			}),
			DOM.addStandardDisposableListener(inputBox.inputElement, DOM.EventType.KEY_DOWN, (e: IKeyboardEvent) => {
				if (e.equals(KeyCode.Enter)) {
					if (inputBox.validate()) {
						done(true, true);
					}
				} else if (e.equals(KeyCode.Escape)) {
					done(false, true);
				}
			}),
			DOM.addStandardDisposableListener(inputBox.inputElement, DOM.EventType.KEY_UP, (e: IKeyboardEvent) => {
				showInputBoxNotification();
			}),
			DOM.addDisposableListener(inputBox.inputElement, DOM.EventType.BLUR, () => {
				done(inputBox.isInputValid(), true);
			}),
			label,
			styler
		];

		return toDisposable(() => {
			done(false, false);
		});
	}

	disposeElement(element: ITreeNode<ExplorerItem, FuzzyScore>, index: number, templateData: IFileTemplateData): void {
		templateData.elementDisposable.dispose();
	}

	disposeCompressedElements(node: ITreeNode<ICompressedTreeNode<ExplorerItem>, FuzzyScore>, index: number, templateData: IFileTemplateData): void {
		templateData.elementDisposable.dispose();
	}

	disposeTemplate(templateData: IFileTemplateData): void {
		templateData.elementDisposable.dispose();
		templateData.label.dispose();
	}

	getCompressedNavigationController(stat: ExplorerItem): ICompressedNavigationController | undefined {
		return this.compressedNavigationControllers.get(stat);
	}

	// IAccessibilityProvider

	getAriaLabel(element: ExplorerItem): string {
		return element.name;
	}

	getActiveDescendantId(stat: ExplorerItem): string | undefined {
		const compressedNavigationController = this.compressedNavigationControllers.get(stat);
		return compressedNavigationController?.currentId;
	}

	dispose(): void {
		this.configListener.dispose();
	}
}

interface CachedParsedExpression {
	original: glob.IExpression;
	parsed: glob.ParsedExpression;
}

/**
 * Respectes files.exclude setting in filtering out content from the explorer.
 * Makes sure that visible editors are always shown in the explorer even if they are filtered out by settings.
 */
export class FilesFilter implements ITreeFilter<ExplorerItem, FuzzyScore> {
	private hiddenExpressionPerRoot: Map<string, CachedParsedExpression>;
	private hiddenUris = new Set<URI>();
	private editorsAffectingFilter = new Set<IEditorInput>();
	private _onDidChange = new Emitter<void>();
	private toDispose: IDisposable[] = [];

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		this.hiddenExpressionPerRoot = new Map<string, CachedParsedExpression>();
		this.toDispose.push(this.contextService.onDidChangeWorkspaceFolders(() => this.updateConfiguration()));
		this.toDispose.push(this.configurationService.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('files.exclude')) {
				this.updateConfiguration();
			}
		}));
		this.toDispose.push(this.editorService.onDidVisibleEditorsChange(() => {
			const editors = this.editorService.visibleEditors;
			let shouldFire = false;
			this.hiddenUris.forEach(u => {
				editors.forEach(e => {
					if (e.resource && isEqualOrParent(e.resource, u)) {
						// A filtered resource suddenly became visible since user opened an editor
						shouldFire = true;
					}
				});
			});

			this.editorsAffectingFilter.forEach(e => {
				if (!editors.includes(e)) {
					// Editor that was affecting filtering is no longer visible
					shouldFire = true;
				}
			});
			if (shouldFire) {
				this.editorsAffectingFilter.clear();
				this.hiddenUris.clear();
				this._onDidChange.fire();
			}
		}));
		this.updateConfiguration();
	}

	get onDidChange(): Event<void> {
		return this._onDidChange.event;
	}

	private updateConfiguration(): void {
		let shouldFire = false;
		this.contextService.getWorkspace().folders.forEach(folder => {
			const configuration = this.configurationService.getValue<IFilesConfiguration>({ resource: folder.uri });
			const excludesConfig: glob.IExpression = configuration?.files?.exclude || Object.create(null);

			if (!shouldFire) {
				const cached = this.hiddenExpressionPerRoot.get(folder.uri.toString());
				shouldFire = !cached || !equals(cached.original, excludesConfig);
			}

			const excludesConfigCopy = deepClone(excludesConfig); // do not keep the config, as it gets mutated under our hoods

			this.hiddenExpressionPerRoot.set(folder.uri.toString(), { original: excludesConfigCopy, parsed: glob.parse(excludesConfigCopy) });
		});

		if (shouldFire) {
			this.editorsAffectingFilter.clear();
			this.hiddenUris.clear();
			this._onDidChange.fire();
		}
	}

	filter(stat: ExplorerItem, parentVisibility: TreeVisibility): TreeFilterResult<FuzzyScore> {
		const isVisible = this.isVisible(stat, parentVisibility);
		if (isVisible) {
			this.hiddenUris.delete(stat.resource);
		} else {
			this.hiddenUris.add(stat.resource);
		}

		return isVisible;
	}

	private isVisible(stat: ExplorerItem, parentVisibility: TreeVisibility): boolean {
		stat.isExcluded = false;
		if (parentVisibility === TreeVisibility.Hidden) {
			stat.isExcluded = true;
			return false;
		}
		if (this.explorerService.getEditableData(stat) || stat.isRoot) {
			return true; // always visible
		}

		// Hide those that match Hidden Patterns
		const cached = this.hiddenExpressionPerRoot.get(stat.root.resource.toString());
		if ((cached && cached.parsed(path.relative(stat.root.resource.path, stat.resource.path), stat.name, name => !!(stat.parent && stat.parent.getChild(name)))) || stat.parent?.isExcluded) {
			stat.isExcluded = true;
			const editors = this.editorService.visibleEditors;
			const editor = editors.find(e => e.resource && isEqualOrParent(e.resource, stat.resource));
			if (editor) {
				this.editorsAffectingFilter.add(editor);
				return true; // Show all opened files and their parents
			}

			return false; // hidden through pattern
		}

		return true;
	}

	dispose(): void {
		dispose(this.toDispose);
	}
}

// Explorer Sorter
export class FileSorter implements ITreeSorter<ExplorerItem> {

	constructor(
		@IExplorerService private readonly explorerService: IExplorerService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService
	) { }

	compare(statA: ExplorerItem, statB: ExplorerItem): number {
		// Do not sort roots
		if (statA.isRoot) {
			if (statB.isRoot) {
				const workspaceA = this.contextService.getWorkspaceFolder(statA.resource);
				const workspaceB = this.contextService.getWorkspaceFolder(statB.resource);
				return workspaceA && workspaceB ? (workspaceA.index - workspaceB.index) : -1;
			}

			return -1;
		}

		if (statB.isRoot) {
			return 1;
		}

		const sortOrder = this.explorerService.sortOrder;

		// Sort Directories
		switch (sortOrder) {
			case 'type':
				if (statA.isDirectory && !statB.isDirectory) {
					return -1;
				}

				if (statB.isDirectory && !statA.isDirectory) {
					return 1;
				}

				if (statA.isDirectory && statB.isDirectory) {
					return compareFileNamesNumeric(statA.name, statB.name);
				}

				break;

			case 'filesFirst':
				if (statA.isDirectory && !statB.isDirectory) {
					return 1;
				}

				if (statB.isDirectory && !statA.isDirectory) {
					return -1;
				}

				break;

			case 'mixed':
				break; // not sorting when "mixed" is on

			default: /* 'default', 'modified' */
				if (statA.isDirectory && !statB.isDirectory) {
					return -1;
				}

				if (statB.isDirectory && !statA.isDirectory) {
					return 1;
				}

				break;
		}

		// Sort Files
		switch (sortOrder) {
			case 'type':
				return compareFileExtensionsNumeric(statA.name, statB.name);

			case 'modified':
				if (statA.mtime !== statB.mtime) {
					return (statA.mtime && statB.mtime && statA.mtime < statB.mtime) ? 1 : -1;
				}

				return compareFileNamesNumeric(statA.name, statB.name);

			default: /* 'default', 'mixed', 'filesFirst' */
				return compareFileNamesNumeric(statA.name, statB.name);
		}
	}
}

function getFileOverwriteConfirm(name: string): IConfirmation {
	return {
		message: localize('confirmOverwrite', "A file or folder with the name '{0}' already exists in the destination folder. Do you want to replace it?", name),
		detail: localize('irreversible', "This action is irreversible!"),
		primaryButton: localize({ key: 'replaceButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
		type: 'warning'
	};
}

function getMultipleFilesOverwriteConfirm(files: URI[]): IConfirmation {
	if (files.length > 1) {
		return {
			message: localize('confirmManyOverwrites', "The following {0} files and/or folders already exist in the destination folder. Do you want to replace them?", files.length),
			detail: getFileNamesMessage(files) + '\n' + localize('irreversible', "This action is irreversible!"),
			primaryButton: localize({ key: 'replaceButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
			type: 'warning'
		};
	}

	return getFileOverwriteConfirm(basename(files[0]));
}

interface IWebkitDataTransfer {
	items: IWebkitDataTransferItem[];
}

interface IWebkitDataTransferItem {
	webkitGetAsEntry(): IWebkitDataTransferItemEntry;
}

interface IWebkitDataTransferItemEntry {
	name: string | undefined;
	isFile: boolean;
	isDirectory: boolean;

	file(resolve: (file: File) => void, reject: () => void): void;
	createReader(): IWebkitDataTransferItemEntryReader;
}

interface IWebkitDataTransferItemEntryReader {
	readEntries(resolve: (file: IWebkitDataTransferItemEntry[]) => void, reject: () => void): void
}

interface IUploadOperation {
	filesTotal: number;
	filesUploaded: number;

	startTime: number;
	bytesUploaded: number;
}

export class FileDragAndDrop implements ITreeDragAndDrop<ExplorerItem> {
	private static readonly CONFIRM_DND_SETTING_KEY = 'explorer.confirmDragAndDrop';

	private compressedDragOverElement: HTMLElement | undefined;
	private compressedDropTargetDisposable: IDisposable = Disposable.None;

	private toDispose: IDisposable[];
	private dropEnabled = false;

	constructor(
		@INotificationService private notificationService: INotificationService,
		@IExplorerService private explorerService: IExplorerService,
		@IEditorService private editorService: IEditorService,
		@IDialogService private dialogService: IDialogService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IFileService private fileService: IFileService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IWorkingCopyFileService private workingCopyFileService: IWorkingCopyFileService,
		@IHostService private hostService: IHostService,
		@IWorkspaceEditingService private workspaceEditingService: IWorkspaceEditingService,
		@IProgressService private readonly progressService: IProgressService
	) {
		this.toDispose = [];

		const updateDropEnablement = () => {
			this.dropEnabled = this.configurationService.getValue('explorer.enableDragAndDrop');
		};
		updateDropEnablement();
		this.toDispose.push(this.configurationService.onDidChangeConfiguration((e) => updateDropEnablement()));
	}

	onDragOver(data: IDragAndDropData, target: ExplorerItem | undefined, targetIndex: number | undefined, originalEvent: DragEvent): boolean | ITreeDragOverReaction {
		if (!this.dropEnabled) {
			return false;
		}

		// Compressed folders
		if (target) {
			const compressedTarget = FileDragAndDrop.getCompressedStatFromDragEvent(target, originalEvent);

			if (compressedTarget) {
				const iconLabelName = getIconLabelNameFromHTMLElement(originalEvent.target);

				if (iconLabelName && iconLabelName.index < iconLabelName.count - 1) {
					const result = this.handleDragOver(data, compressedTarget, targetIndex, originalEvent);

					if (result) {
						if (iconLabelName.element !== this.compressedDragOverElement) {
							this.compressedDragOverElement = iconLabelName.element;
							this.compressedDropTargetDisposable.dispose();
							this.compressedDropTargetDisposable = toDisposable(() => {
								DOM.removeClass(iconLabelName.element, 'drop-target');
								this.compressedDragOverElement = undefined;
							});

							DOM.addClass(iconLabelName.element, 'drop-target');
						}

						return typeof result === 'boolean' ? result : { ...result, feedback: [] };
					}

					this.compressedDropTargetDisposable.dispose();
					return false;
				}
			}
		}

		this.compressedDropTargetDisposable.dispose();
		return this.handleDragOver(data, target, targetIndex, originalEvent);
	}

	private handleDragOver(data: IDragAndDropData, target: ExplorerItem | undefined, targetIndex: number | undefined, originalEvent: DragEvent): boolean | ITreeDragOverReaction {
		const isCopy = originalEvent && ((originalEvent.ctrlKey && !isMacintosh) || (originalEvent.altKey && isMacintosh));
		const fromDesktop = data instanceof DesktopDragAndDropData;
		const effect = (fromDesktop || isCopy) ? ListDragOverEffect.Copy : ListDragOverEffect.Move;

		// Desktop DND
		if (fromDesktop) {
			if (!containsDragType(originalEvent, DataTransfers.FILES, CodeDataTransfers.FILES)) {
				return false;
			}
		}

		// Other-Tree DND
		else if (data instanceof ExternalElementsDragAndDropData) {
			return false;
		}

		// In-Explorer DND
		else {
			const items = FileDragAndDrop.getStatsFromDragAndDropData(data as ElementsDragAndDropData<ExplorerItem, ExplorerItem[]>);

			if (!target) {
				// Dropping onto the empty area. Do not accept if items dragged are already
				// children of the root unless we are copying the file
				if (!isCopy && items.every(i => !!i.parent && i.parent.isRoot)) {
					return false;
				}

				return { accept: true, bubble: TreeDragOverBubble.Down, effect, autoExpand: false };
			}

			if (!Array.isArray(items)) {
				return false;
			}

			if (items.some((source) => {
				if (source.isRoot && target instanceof ExplorerItem && !target.isRoot) {
					return true; // Root folder can not be moved to a non root file stat.
				}

				if (source.resource.toString() === target.resource.toString()) {
					return true; // Can not move anything onto itself
				}

				if (source.isRoot && target instanceof ExplorerItem && target.isRoot) {
					// Disable moving workspace roots in one another
					return false;
				}

				if (!isCopy && dirname(source.resource).toString() === target.resource.toString()) {
					return true; // Can not move a file to the same parent unless we copy
				}

				if (isEqualOrParent(target.resource, source.resource)) {
					return true; // Can not move a parent folder into one of its children
				}

				return false;
			})) {
				return false;
			}
		}

		// All (target = model)
		if (!target) {
			return { accept: true, bubble: TreeDragOverBubble.Down, effect };
		}

		// All (target = file/folder)
		else {
			if (target.isDirectory) {
				if (target.isReadonly) {
					return false;
				}

				return { accept: true, bubble: TreeDragOverBubble.Down, effect, autoExpand: true };
			}

			if (this.contextService.getWorkspace().folders.every(folder => folder.uri.toString() !== target.resource.toString())) {
				return { accept: true, bubble: TreeDragOverBubble.Up, effect };
			}
		}

		return false;
	}

	getDragURI(element: ExplorerItem): string | null {
		if (this.explorerService.isEditable(element)) {
			return null;
		}

		return element.resource.toString();
	}

	getDragLabel(elements: ExplorerItem[], originalEvent: DragEvent): string | undefined {
		if (elements.length === 1) {
			const stat = FileDragAndDrop.getCompressedStatFromDragEvent(elements[0], originalEvent);
			return stat.name;
		}

		return String(elements.length);
	}

	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		const items = FileDragAndDrop.getStatsFromDragAndDropData(data as ElementsDragAndDropData<ExplorerItem, ExplorerItem[]>, originalEvent);
		if (items && items.length && originalEvent.dataTransfer) {
			// Apply some datatransfer types to allow for dragging the element outside of the application
			this.instantiationService.invokeFunction(fillResourceDataTransfers, items, undefined, originalEvent);

			// The only custom data transfer we set from the explorer is a file transfer
			// to be able to DND between multiple code file explorers across windows
			const fileResources = items.filter(s => !s.isDirectory && s.resource.scheme === Schemas.file).map(r => r.resource.fsPath);
			if (fileResources.length) {
				originalEvent.dataTransfer.setData(CodeDataTransfers.FILES, JSON.stringify(fileResources));
			}
		}
	}

	drop(data: IDragAndDropData, target: ExplorerItem | undefined, targetIndex: number | undefined, originalEvent: DragEvent): void {
		this.compressedDropTargetDisposable.dispose();

		// Find compressed target
		if (target) {
			const compressedTarget = FileDragAndDrop.getCompressedStatFromDragEvent(target, originalEvent);

			if (compressedTarget) {
				target = compressedTarget;
			}
		}

		// Find parent to add to
		if (!target) {
			target = this.explorerService.roots[this.explorerService.roots.length - 1];
		}
		if (!target.isDirectory && target.parent) {
			target = target.parent;
		}
		if (target.isReadonly) {
			return;
		}

		// Desktop DND (Import file)
		if (data instanceof DesktopDragAndDropData) {
			if (isWeb) {
				this.handleWebExternalDrop(data, target, originalEvent).then(undefined, e => this.notificationService.warn(e));
			} else {
				this.handleExternalDrop(data, target, originalEvent).then(undefined, e => this.notificationService.warn(e));
			}
		}
		// In-Explorer DND (Move/Copy file)
		else {
			this.handleExplorerDrop(data as ElementsDragAndDropData<ExplorerItem, ExplorerItem[]>, target, originalEvent).then(undefined, e => this.notificationService.warn(e));
		}
	}

	private async handleWebExternalDrop(data: DesktopDragAndDropData, target: ExplorerItem, originalEvent: DragEvent): Promise<void> {
		const items = (originalEvent.dataTransfer as unknown as IWebkitDataTransfer).items;

		// Somehow the items thing is being modified at random, maybe as a security
		// measure since this is a DND operation. As such, we copy the items into
		// an array we own as early as possible before using it.
		const entries: IWebkitDataTransferItemEntry[] = [];
		for (const item of items) {
			entries.push(item.webkitGetAsEntry());
		}

		const results: { isFile: boolean, resource: URI }[] = [];
		const cts = new CancellationTokenSource();
		const operation: IUploadOperation = { filesTotal: entries.length, filesUploaded: 0, startTime: Date.now(), bytesUploaded: 0 };

		// Start upload and report progress globally
		const uploadPromise = this.progressService.withProgress({
			location: ProgressLocation.Window,
			delay: 800,
			cancellable: true,
			title: localize('uploadingFiles', "Uploading")
		}, async progress => {
			for (let entry of entries) {

				// Confirm overwrite as needed
				if (target && entry.name && target.getChild(entry.name)) {
					const { confirmed } = await this.dialogService.confirm(getFileOverwriteConfirm(entry.name));
					if (!confirmed) {
						continue;
					}

					await this.workingCopyFileService.delete([joinPath(target.resource, entry.name)], { recursive: true });
				}

				// Upload entry
				const result = await this.doUploadWebFileEntry(entry, target.resource, target, progress, operation, cts.token);
				if (result) {
					results.push(result);
				}
			}
		}, () => cts.dispose(true));

		// Also indicate progress in the files view
		this.progressService.withProgress({ location: VIEW_ID, delay: 800 }, () => uploadPromise);

		// Wait until upload is done
		await uploadPromise;

		// Open uploaded file in editor only if we upload just one
		if (!cts.token.isCancellationRequested && results.length === 1 && results[0].isFile) {
			await this.editorService.openEditor({ resource: results[0].resource, options: { pinned: true } });
		}
	}

	private async doUploadWebFileEntry(entry: IWebkitDataTransferItemEntry, parentResource: URI, target: ExplorerItem | undefined, progress: IProgress<IProgressStep>, operation: IUploadOperation, token: CancellationToken): Promise<{ isFile: boolean, resource: URI } | undefined> {
		if (token.isCancellationRequested || !entry.name || (!entry.isFile && !entry.isDirectory)) {
			return undefined;
		}

		// Report progress
		let fileBytesUploaded = 0;
		const reportProgress = (fileSize: number, bytesUploaded: number): void => {
			fileBytesUploaded += bytesUploaded;
			operation.bytesUploaded += bytesUploaded;

			const bytesUploadedPerSecond = operation.bytesUploaded / ((Date.now() - operation.startTime) / 1000);

			let message: string;
			if (operation.filesTotal === 1 && entry.name) {
				message = entry.name;
			} else {
				message = localize('uploadProgress', "{0} of {1} files ({2}/s)", operation.filesUploaded, operation.filesTotal, BinarySize.formatSize(bytesUploadedPerSecond));
			}

			if (fileSize > BinarySize.MB) {
				message = localize('uploadProgressDetail', "{0} ({1} of {2}, {3}/s)", message, BinarySize.formatSize(fileBytesUploaded), BinarySize.formatSize(fileSize), BinarySize.formatSize(bytesUploadedPerSecond));
			}

			progress.report({ message });
		};
		operation.filesUploaded++;
		reportProgress(0, 0);

		// Handle file upload
		const resource = joinPath(parentResource, entry.name);
		if (entry.isFile) {
			const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));

			if (token.isCancellationRequested) {
				return undefined;
			}

			// Chrome/Edge/Firefox support stream method
			if (typeof file.stream === 'function') {
				await this.doUploadWebFileEntryBuffered(resource, file, reportProgress, token);
			}

			// Fallback to unbuffered upload for other browsers
			else {
				await this.doUploadWebFileEntryUnbuffered(resource, file, reportProgress);
			}

			return { isFile: true, resource };
		}

		// Handle folder upload
		else {

			// Create target folder
			await this.fileService.createFolder(resource);

			if (token.isCancellationRequested) {
				return undefined;
			}

			// Recursive upload files in this directory
			const dirReader = entry.createReader();
			const childEntries: IWebkitDataTransferItemEntry[] = [];
			let done = false;
			do {
				const childEntriesChunk = await new Promise<IWebkitDataTransferItemEntry[]>((resolve, reject) => dirReader.readEntries(resolve, reject));
				if (childEntriesChunk.length > 0) {
					childEntries.push(...childEntriesChunk);
				} else {
					done = true; // an empty array is a signal that all entries have been read
				}
			} while (!done);

			// Update operation total based on new counts
			operation.filesTotal += childEntries.length;

			// Upload all entries as files to target
			const folderTarget = target && target.getChild(entry.name) || undefined;
			for (let childEntry of childEntries) {
				await this.doUploadWebFileEntry(childEntry, resource, folderTarget, progress, operation, token);
			}

			return { isFile: false, resource };
		}
	}

	private async doUploadWebFileEntryBuffered(resource: URI, file: File, progressReporter: (fileSize: number, bytesUploaded: number) => void, token: CancellationToken): Promise<void> {
		const writeableStream = newWriteableBufferStream({
			// Set a highWaterMark to prevent the stream
			// for file upload to produce large buffers
			// in-memory
			highWaterMark: 10
		});
		const writeFilePromise = this.fileService.writeFile(resource, writeableStream);

		// Read the file in chunks using File.stream() web APIs
		try {
			const reader: ReadableStreamDefaultReader<Uint8Array> = file.stream().getReader();

			let res = await reader.read();
			while (!res.done) {
				if (token.isCancellationRequested) {
					return undefined;
				}

				// Write buffer into stream but make sure to wait
				// in case the highWaterMark is reached
				const buffer = VSBuffer.wrap(res.value);
				await writeableStream.write(buffer);

				if (token.isCancellationRequested) {
					return undefined;
				}

				// Report progress
				progressReporter(file.size, buffer.byteLength);

				res = await reader.read();
			}
			writeableStream.end(res.value instanceof Uint8Array ? VSBuffer.wrap(res.value) : undefined);
		} catch (error) {
			writeableStream.end(error);
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		// Wait for file being written to target
		await writeFilePromise;
	}

	private doUploadWebFileEntryUnbuffered(resource: URI, file: File, progressReporter: (fileSize: number, bytesUploaded: number) => void): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = async event => {
				try {
					if (event.target?.result instanceof ArrayBuffer) {
						const buffer = VSBuffer.wrap(new Uint8Array(event.target.result));
						await this.fileService.writeFile(resource, buffer);

						// Report progress
						progressReporter(file.size, buffer.byteLength);
					} else {
						throw new Error('Could not read from dropped file.');
					}

					resolve();
				} catch (error) {
					reject(error);
				}
			};

			// Start reading the file to trigger `onload`
			reader.readAsArrayBuffer(file);
		});
	}

	private async handleExternalDrop(data: DesktopDragAndDropData, target: ExplorerItem, originalEvent: DragEvent): Promise<void> {

		// Check for dropped external files to be folders
		const droppedResources = extractResources(originalEvent, true);
		const result = await this.fileService.resolveAll(droppedResources.map(droppedResource => ({ resource: droppedResource.resource })));

		// Pass focus to window
		this.hostService.focus();

		// Handle folders by adding to workspace if we are in workspace context
		const folders = result.filter(r => r.success && r.stat && r.stat.isDirectory).map(result => ({ uri: result.stat!.resource }));
		if (folders.length > 0) {
			const buttons = [
				folders.length > 1 ? localize('copyFolders', "&&Copy Folders") : localize('copyFolder', "&&Copy Folder"),
				localize('cancel', "Cancel")
			];
			const workspaceFolderSchemas = this.contextService.getWorkspace().folders.map(f => f.uri.scheme);
			let message = folders.length > 1 ? localize('copyfolders', "Are you sure to want to copy folders?") : localize('copyfolder', "Are you sure to want to copy '{0}'?", basename(folders[0].uri));
			if (folders.some(f => workspaceFolderSchemas.indexOf(f.uri.scheme) >= 0)) {
				// We only allow to add a folder to the workspace if there is already a workspace folder with that scheme
				buttons.unshift(folders.length > 1 ? localize('addFolders', "&&Add Folders to Workspace") : localize('addFolder', "&&Add Folder to Workspace"));
				message = folders.length > 1 ? localize('dropFolders', "Do you want to copy the folders or add the folders to the workspace?")
					: localize('dropFolder', "Do you want to copy '{0}' or add '{0}' as a folder to the workspace?", basename(folders[0].uri));
			}

			const { choice } = await this.dialogService.show(Severity.Info, message, buttons);
			if (choice === buttons.length - 3) {
				return this.workspaceEditingService.addFolders(folders);
			}
			if (choice === buttons.length - 2) {
				return this.addResources(target, droppedResources.map(res => res.resource));
			}

			return undefined;
		}

		// Handle dropped files (only support FileStat as target)
		else if (target instanceof ExplorerItem) {
			return this.addResources(target, droppedResources.map(res => res.resource));
		}
	}

	private async addResources(target: ExplorerItem, resources: URI[]): Promise<void> {
		if (resources && resources.length > 0) {

			// Resolve target to check for name collisions and ask user
			const targetStat = await this.fileService.resolve(target.resource);

			// Check for name collisions
			const targetNames = new Set<string>();
			const caseSensitive = this.fileService.hasCapability(target.resource, FileSystemProviderCapabilities.PathCaseSensitive);
			if (targetStat.children) {
				targetStat.children.forEach(child => {
					targetNames.add(caseSensitive ? child.name : child.name.toLowerCase());
				});
			}

			// Run add in sequence
			const addPromisesFactory: ITask<Promise<void>>[] = [];
			await Promise.all(resources.map(async resource => {
				if (targetNames.has(caseSensitive ? basename(resource) : basename(resource).toLowerCase())) {
					const confirmationResult = await this.dialogService.confirm(getFileOverwriteConfirm(basename(resource)));
					if (!confirmationResult.confirmed) {
						return;
					}
				}

				addPromisesFactory.push(async () => {
					const sourceFile = resource;
					const targetFile = joinPath(target.resource, basename(sourceFile));

					const stat = (await this.workingCopyFileService.copy([{ source: sourceFile, target: targetFile }], { overwrite: true }))[0];
					// if we only add one file, just open it directly
					if (resources.length === 1 && !stat.isDirectory) {
						this.editorService.openEditor({ resource: stat.resource, options: { pinned: true } });
					}
				});
			}));

			await sequence(addPromisesFactory);
		}
	}

	private async handleExplorerDrop(data: ElementsDragAndDropData<ExplorerItem, ExplorerItem[]>, target: ExplorerItem, originalEvent: DragEvent): Promise<void> {
		const elementsData = FileDragAndDrop.getStatsFromDragAndDropData(data);
		const items = distinctParents(elementsData, s => s.resource);
		const isCopy = (originalEvent.ctrlKey && !isMacintosh) || (originalEvent.altKey && isMacintosh);

		// Handle confirm setting
		const confirmDragAndDrop = !isCopy && this.configurationService.getValue<boolean>(FileDragAndDrop.CONFIRM_DND_SETTING_KEY);
		if (confirmDragAndDrop) {
			const message = items.length > 1 && items.every(s => s.isRoot) ? localize('confirmRootsMove', "Are you sure you want to change the order of multiple root folders in your workspace?")
				: items.length > 1 ? localize('confirmMultiMove', "Are you sure you want to move the following {0} files into '{1}'?", items.length, target.name)
					: items[0].isRoot ? localize('confirmRootMove', "Are you sure you want to change the order of root folder '{0}' in your workspace?", items[0].name)
						: localize('confirmMove', "Are you sure you want to move '{0}' into '{1}'?", items[0].name, target.name);
			const detail = items.length > 1 && !items.every(s => s.isRoot) ? getFileNamesMessage(items.map(i => i.resource)) : undefined;

			const confirmation = await this.dialogService.confirm({
				message,
				detail,
				checkbox: {
					label: localize('doNotAskAgain', "Do not ask me again")
				},
				type: 'question',
				primaryButton: localize({ key: 'moveButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Move")
			});

			if (!confirmation.confirmed) {
				return;
			}

			// Check for confirmation checkbox
			if (confirmation.checkboxChecked === true) {
				await this.configurationService.updateValue(FileDragAndDrop.CONFIRM_DND_SETTING_KEY, false, ConfigurationTarget.USER);
			}
		}

		await this.doHandleRootDrop(items.filter(s => s.isRoot), target);

		const sources = items.filter(s => !s.isRoot);
		if (isCopy) {
			await this.doHandleExplorerDropOnCopy(sources, target);
		} else {
			return this.doHandleExplorerDropOnMove(sources, target);
		}
	}

	private doHandleRootDrop(roots: ExplorerItem[], target: ExplorerItem): Promise<void> {
		if (roots.length === 0) {
			return Promise.resolve(undefined);
		}

		const folders = this.contextService.getWorkspace().folders;
		let targetIndex: number | undefined;
		const workspaceCreationData: IWorkspaceFolderCreationData[] = [];
		const rootsToMove: IWorkspaceFolderCreationData[] = [];

		for (let index = 0; index < folders.length; index++) {
			const data = {
				uri: folders[index].uri,
				name: folders[index].name
			};
			if (target instanceof ExplorerItem && folders[index].uri.toString() === target.resource.toString()) {
				targetIndex = index;
			}

			if (roots.every(r => r.resource.toString() !== folders[index].uri.toString())) {
				workspaceCreationData.push(data);
			} else {
				rootsToMove.push(data);
			}
		}
		if (targetIndex === undefined) {
			targetIndex = workspaceCreationData.length;
		}

		workspaceCreationData.splice(targetIndex, 0, ...rootsToMove);
		return this.workspaceEditingService.updateFolders(0, workspaceCreationData.length, workspaceCreationData);
	}

	private async doHandleExplorerDropOnCopy(sources: ExplorerItem[], target: ExplorerItem): Promise<void> {
		// Reuse duplicate action when user copies
		const incrementalNaming = this.configurationService.getValue<IFilesConfiguration>().explorer.incrementalNaming;
		const sourceTargetPairs = sources.map(({ resource, isDirectory }) => ({ source: resource, target: findValidPasteFileTarget(this.explorerService, target, { resource, isDirectory, allowOverwrite: false }, incrementalNaming) }));
		const stats = await this.workingCopyFileService.copy(sourceTargetPairs);
		const editors = stats.filter(stat => !stat.isDirectory).map(({ resource }) => ({ resource, options: { pinned: true } }));

		await this.editorService.openEditors(editors);
	}

	private async doHandleExplorerDropOnMove(sources: ExplorerItem[], target: ExplorerItem): Promise<void> {

		// Do not allow moving readonly items
		const sourceTargetPairs = sources.filter(source => !source.isReadonly).map(source => ({ source: source.resource, target: joinPath(target.resource, source.name) }));

		try {
			await this.workingCopyFileService.move(sourceTargetPairs);
		} catch (error) {
			// Conflict
			if ((<FileOperationError>error).fileOperationResult === FileOperationResult.FILE_MOVE_CONFLICT) {

				const overwrites: URI[] = [];
				for (const { target } of sourceTargetPairs) {
					if (await this.fileService.exists(target)) {
						overwrites.push(target);
					}
				}

				const confirm = getMultipleFilesOverwriteConfirm(overwrites);
				// Move with overwrite if the user confirms
				const { confirmed } = await this.dialogService.confirm(confirm);
				if (confirmed) {
					try {
						await this.workingCopyFileService.move(sourceTargetPairs, { overwrite: true });
					} catch (error) {
						this.notificationService.error(error);
					}
				}
			}
			// Any other error
			else {
				this.notificationService.error(error);
			}
		}
	}

	private static getStatsFromDragAndDropData(data: ElementsDragAndDropData<ExplorerItem, ExplorerItem[]>, dragStartEvent?: DragEvent): ExplorerItem[] {
		if (data.context) {
			return data.context;
		}

		// Detect compressed folder dragging
		if (dragStartEvent && data.elements.length === 1) {
			data.context = [FileDragAndDrop.getCompressedStatFromDragEvent(data.elements[0], dragStartEvent)];
			return data.context;
		}

		return data.elements;
	}

	private static getCompressedStatFromDragEvent(stat: ExplorerItem, dragEvent: DragEvent): ExplorerItem {
		const target = document.elementFromPoint(dragEvent.clientX, dragEvent.clientY);
		const iconLabelName = getIconLabelNameFromHTMLElement(target);

		if (iconLabelName) {
			const { count, index } = iconLabelName;

			let i = count - 1;
			while (i > index && stat.parent) {
				stat = stat.parent;
				i--;
			}

			return stat;
		}

		return stat;
	}

	onDragEnd(): void {
		this.compressedDropTargetDisposable.dispose();
	}
}

function getIconLabelNameFromHTMLElement(target: HTMLElement | EventTarget | Element | null): { element: HTMLElement, count: number, index: number } | null {
	if (!(target instanceof HTMLElement)) {
		return null;
	}

	let element: HTMLElement | null = target;

	while (element && !DOM.hasClass(element, 'monaco-list-row')) {
		if (DOM.hasClass(element, 'label-name') && element.hasAttribute('data-icon-label-count')) {
			const count = Number(element.getAttribute('data-icon-label-count'));
			const index = Number(element.getAttribute('data-icon-label-index'));

			if (isNumber(count) && isNumber(index)) {
				return { element: element, count, index };
			}
		}

		element = element.parentElement;
	}

	return null;
}

export function isCompressedFolderName(target: HTMLElement | EventTarget | Element | null): boolean {
	return !!getIconLabelNameFromHTMLElement(target);
}

export class ExplorerCompressionDelegate implements ITreeCompressionDelegate<ExplorerItem> {

	isIncompressible(stat: ExplorerItem): boolean {
		return stat.isRoot || !stat.isDirectory || stat instanceof NewExplorerItem || (!stat.parent || stat.parent.isRoot);
	}
}
