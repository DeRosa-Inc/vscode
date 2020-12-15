/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { INativeEnvironmentService } from 'vs/platform/environment/node/environmentService';
import { joinPath, relativePath } from 'vs/base/common/resources';

export function toBackupWorkspaceResource(backupWorkspacePath: string, environmentService: INativeEnvironmentService): URI {
	return joinPath(environmentService.userRoamingDataHome, relativePath(URI.file(environmentService.userDataPath), URI.file(backupWorkspacePath))!);
}
