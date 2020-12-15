/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { v4 as uuid } from 'uuid';
import { keychain } from './common/keychain';
import { GitHubServer, NETWORK_ERROR } from './githubServer';
import Logger from './common/logger';

export const onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationSessionsChangeEvent>();

interface SessionData {
	id: string;
	account?: {
		label?: string;
		displayName?: string;
		id: string;
	}
	scopes: string[];
	accessToken: string;
}

export class GitHubAuthenticationProvider {
	private _sessions: vscode.AuthenticationSession[] = [];
	private _githubServer = new GitHubServer();

	public async initialize(): Promise<void> {
		try {
			this._sessions = await this.readSessions();
		} catch (e) {
			// Ignore, network request failed
		}

		this.pollForChange();
	}

	private pollForChange() {
		setTimeout(async () => {
			let storedSessions: vscode.AuthenticationSession[];
			try {
				storedSessions = await this.readSessions();
			} catch (e) {
				// Ignore, network request failed
				return;
			}

			const added: string[] = [];
			const removed: string[] = [];

			storedSessions.forEach(session => {
				const matchesExisting = this._sessions.some(s => s.id === session.id);
				// Another window added a session to the keychain, add it to our state as well
				if (!matchesExisting) {
					Logger.info('Adding session found in keychain');
					this._sessions.push(session);
					added.push(session.id);
				}
			});

			this._sessions.map(session => {
				const matchesExisting = storedSessions.some(s => s.id === session.id);
				// Another window has logged out, remove from our state
				if (!matchesExisting) {
					Logger.info('Removing session no longer found in keychain');
					const sessionIndex = this._sessions.findIndex(s => s.id === session.id);
					if (sessionIndex > -1) {
						this._sessions.splice(sessionIndex, 1);
					}

					removed.push(session.id);
				}
			});

			if (added.length || removed.length) {
				onDidChangeSessions.fire({ added, removed, changed: [] });
			}

			this.pollForChange();
		}, 1000 * 30);
	}

	private async readSessions(): Promise<vscode.AuthenticationSession[]> {
		const storedSessions = await keychain.getToken();
		if (storedSessions) {
			try {
				const sessionData: SessionData[] = JSON.parse(storedSessions);
				const sessionPromises = sessionData.map(async (session: SessionData): Promise<vscode.AuthenticationSession> => {
					const needsUserInfo = !session.account;
					let userInfo: { id: string, accountName: string };
					if (needsUserInfo) {
						userInfo = await this._githubServer.getUserInfo(session.accessToken);
					}

					return {
						id: session.id,
						account: {
							label: session.account
								? session.account.label || session.account.displayName!
								: userInfo!.accountName,
							id: session.account?.id ?? userInfo!.id
						},
						scopes: session.scopes,
						accessToken: session.accessToken
					};
				});

				return Promise.all(sessionPromises);
			} catch (e) {
				if (e === NETWORK_ERROR) {
					return [];
				}

				Logger.error(`Error reading sessions: ${e}`);
				await keychain.deleteToken();
			}
		}

		return [];
	}

	private async storeSessions(): Promise<void> {
		await keychain.setToken(JSON.stringify(this._sessions));
	}

	get sessions(): vscode.AuthenticationSession[] {
		return this._sessions;
	}

	public async login(scopes: string): Promise<vscode.AuthenticationSession> {
		const token = await this._githubServer.login(scopes);
		const session = await this.tokenToSession(token, scopes.split(' '));
		await this.setToken(session);
		return session;
	}

	public async manuallyProvideToken(): Promise<void> {
		this._githubServer.manuallyProvideToken();
	}

	private async tokenToSession(token: string, scopes: string[]): Promise<vscode.AuthenticationSession> {
		const userInfo = await this._githubServer.getUserInfo(token);
		return {
			id: uuid(),
			accessToken: token,
			account: { label: userInfo.accountName, id: userInfo.id },
			scopes
		};
	}

	private async setToken(session: vscode.AuthenticationSession): Promise<void> {
		const sessionIndex = this._sessions.findIndex(s => s.id === session.id);
		if (sessionIndex > -1) {
			this._sessions.splice(sessionIndex, 1, session);
		} else {
			this._sessions.push(session);
		}

		await this.storeSessions();
	}

	public async logout(id: string) {
		const sessionIndex = this._sessions.findIndex(session => session.id === id);
		if (sessionIndex > -1) {
			this._sessions.splice(sessionIndex, 1);
		}

		await this.storeSessions();
	}
}
