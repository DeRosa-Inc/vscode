/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

function entrypoint(name) {
	return [{ name: name, include: [], exclude: ['vs/css', 'vs/nls'] }];
}

exports.base = [{
	name: 'vs/base/common/worker/simpleWorker',
	include: ['vs/editor/common/services/editorSimpleWorker'],
	prepend: ['vs/loader.js'],
	append: ['vs/base/worker/workerMain'],
	dest: 'vs/base/worker/workerMain.js'
}];

exports.workerExtensionHost = [entrypoint('vs/workbench/services/extensions/worker/extensionHostWorker')];

exports.workbenchDesktop = require('./vs/workbench/buildfile.desktop').collectModules();
exports.workbenchWeb = require('./vs/workbench/buildfile.web').collectModules();

exports.keyboardMaps = [
	entrypoint('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.linux'),
	entrypoint('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.darwin'),
	entrypoint('vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.win')
];

exports.code = require('./vs/code/buildfile').collectModules();

exports.entrypoint = entrypoint;
