/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { virtualMachineHint } from 'vs/base/node/id';
import * as os from 'os';
import { IElectronService } from 'vs/platform/electron/electron-sandbox/electron';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IUpdateService } from 'vs/platform/update/common/update';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { IPanelService } from 'vs/workbench/services/panel/common/panelService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IAccessibilityService } from 'vs/platform/accessibility/common/accessibility';
import { INativeWorkbenchEnvironmentService } from 'vs/workbench/services/environment/electron-browser/environmentService';
import { IStartupMetrics, AbstractTimerService, Writeable } from 'vs/workbench/services/timer/browser/timerService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';

export class TimerService extends AbstractTimerService {

	constructor(
		@IElectronService private readonly _electronService: IElectronService,
		@IWorkbenchEnvironmentService private readonly _environmentService: INativeWorkbenchEnvironmentService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IExtensionService extensionService: IExtensionService,
		@IUpdateService updateService: IUpdateService,
		@IViewletService viewletService: IViewletService,
		@IPanelService panelService: IPanelService,
		@IEditorService editorService: IEditorService,
		@IAccessibilityService accessibilityService: IAccessibilityService,
		@ITelemetryService telemetryService: ITelemetryService,
	) {
		super(lifecycleService, contextService, extensionService, updateService, viewletService, panelService, editorService, accessibilityService, telemetryService);
	}

	protected _isInitialStartup(): boolean {
		return Boolean(this._environmentService.configuration.isInitialStartup);
	}
	protected _didUseCachedData(): boolean {
		return didUseCachedData();
	}
	protected _getWindowCount(): Promise<number> {
		return this._electronService.getWindowCount();
	}

	protected async _extendStartupInfo(info: Writeable<IStartupMetrics>): Promise<void> {
		try {
			info.totalmem = os.totalmem();
			info.freemem = os.freemem();
			info.platform = os.platform();
			info.release = os.release();
			info.arch = os.arch();
			info.loadavg = os.loadavg();

			const processMemoryInfo = await process.getProcessMemoryInfo();
			info.meminfo = {
				workingSetSize: processMemoryInfo.residentSet,
				privateBytes: processMemoryInfo.private,
				sharedBytes: processMemoryInfo.shared
			};

			info.isVMLikelyhood = Math.round((virtualMachineHint.value() * 100));

			const rawCpus = os.cpus();
			if (rawCpus && rawCpus.length > 0) {
				info.cpus = { count: rawCpus.length, speed: rawCpus[0].speed, model: rawCpus[0].model };
			}
		} catch (error) {
			// ignore, be on the safe side with these hardware method calls
		}
	}
}

//#region cached data logic

export function didUseCachedData(): boolean {
	// We surely don't use cached data when we don't tell the loader to do so
	if (!Boolean((<any>global).require.getConfig().nodeCachedData)) {
		return false;
	}
	// There are loader events that signal if cached data was missing, rejected,
	// or used. The former two mean no cached data.
	let cachedDataFound = 0;
	for (const event of require.getStats()) {
		switch (event.type) {
			case LoaderEventType.CachedDataRejected:
				return false;
			case LoaderEventType.CachedDataFound:
				cachedDataFound += 1;
				break;
		}
	}
	return cachedDataFound > 0;
}

//#endregion
