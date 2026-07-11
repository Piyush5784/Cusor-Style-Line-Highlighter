import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

interface GitExtensionExports {
	getAPI(version: 1): GitAPI;
}

interface GitAPI {
	repositories: Repository[];
	getRepository(uri: vscode.Uri): Repository | null;
	onDidOpenRepository: vscode.Event<Repository>;
}

interface Repository {
	rootUri: vscode.Uri;
	state: RepositoryState;
	diffWithHEAD(path: string): Promise<string>;
	apply(patch: string, reverse?: boolean): Promise<void>;
}

interface RepositoryState {
	onDidChange: vscode.Event<void>;
}

interface LineRange {
	start: number;
	end: number;
}

interface Hunk {
	startLine: number;
	endLine: number;
	/** Contiguous runs of actually-added lines within this hunk; what should be highlighted. */
	decorationRanges: LineRange[];
	/** The "@@ -a,b +c,d @@" header line; unique within a file's patch. */
	signature: string;
	/** A minimal valid single-hunk patch (file preamble + this hunk only), usable with `repo.apply`. */
	patchText: string;
}

let decorationType: vscode.TextEditorDecorationType;
let gitApi: GitAPI | undefined;
let currentIndex = -1;
const documentHunks = new Map<string, Hunk[]>();
const acceptedSignatures = new Map<string, Set<string>>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const codeLensEmitter = new vscode.EventEmitter<void>();

let statusPrev: vscode.StatusBarItem;
let statusCount: vscode.StatusBarItem;
let statusNext: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
	decorationType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
		overviewRulerLane: vscode.OverviewRulerLane.Full,
	});
	context.subscriptions.push(decorationType, codeLensEmitter);

	statusPrev = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusPrev.text = '$(arrow-up) Prev';
	statusPrev.command = 'gitChangeHighlighter.previousChange';
	statusCount = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	statusNext = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
	statusNext.text = 'Next $(arrow-down)';
	statusNext.command = 'gitChangeHighlighter.nextChange';
	context.subscriptions.push(statusPrev, statusCount, statusNext);

	const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
	if (gitExtension) {
		const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
		gitApi = exports.getAPI(1);
	}

	if (!gitApi) {
		vscode.window.showWarningMessage('Git Change Highlighter: built-in Git extension is not available.');
	} else {
		context.subscriptions.push(gitApi.onDidOpenRepository(repo => watchRepository(repo, context)));
		for (const repo of gitApi.repositories) {
			watchRepository(repo, context);
		}
	}

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => refreshActiveEditor()),
		vscode.workspace.onDidSaveTextDocument(doc => refreshDocument(doc)),
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new ChangeCodeLensProvider()),
		vscode.commands.registerCommand('gitChangeHighlighter.nextChange', () => moveToChange(1)),
		vscode.commands.registerCommand('gitChangeHighlighter.previousChange', () => moveToChange(-1)),
		vscode.commands.registerCommand('gitChangeHighlighter.refresh', () => refreshActiveEditor()),
		vscode.commands.registerCommand('gitChangeHighlighter.acceptHunk', (uri: vscode.Uri, signature: string) => acceptHunk(uri, signature)),
		vscode.commands.registerCommand('gitChangeHighlighter.rejectHunk', (uri: vscode.Uri, signature: string) => rejectHunk(uri, signature))
	);

	refreshActiveEditor();
}

class ChangeCodeLensProvider implements vscode.CodeLensProvider {
	onDidChangeCodeLenses = codeLensEmitter.event;

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const hunks = documentHunks.get(document.uri.toString()) ?? [];
		const lenses: vscode.CodeLens[] = [];
		hunks.forEach((hunk, idx) => {
			const range = new vscode.Range(hunk.startLine, 0, hunk.startLine, 0);
			lenses.push(new vscode.CodeLens(range, { title: `Change ${idx + 1}/${hunks.length}`, command: '' }));
			lenses.push(new vscode.CodeLens(range, {
				title: '$(check) Accept',
				command: 'gitChangeHighlighter.acceptHunk',
				arguments: [document.uri, hunk.signature],
			}));
			lenses.push(new vscode.CodeLens(range, {
				title: '$(x) Reject',
				command: 'gitChangeHighlighter.rejectHunk',
				arguments: [document.uri, hunk.signature],
			}));
		});
		return lenses;
	}
}

function watchRepository(repo: Repository, context: vscode.ExtensionContext) {
	context.subscriptions.push(
		repo.state.onDidChange(() => {
			const key = repo.rootUri.toString();
			const existing = refreshTimers.get(key);
			if (existing) {
				clearTimeout(existing);
			}
			refreshTimers.set(key, setTimeout(() => refreshActiveEditor(), 300));
		})
	);
	refreshActiveEditor();
}

function refreshActiveEditor() {
	currentIndex = -1;
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		updateStatusBar();
		return;
	}
	refreshDocument(editor.document);
}

async function refreshDocument(document: vscode.TextDocument) {
	const key = document.uri.toString();
	if (document.uri.scheme !== 'file' || !gitApi) {
		documentHunks.delete(key);
		codeLensEmitter.fire();
		updateStatusBar();
		return;
	}

	const repo = gitApi.getRepository(document.uri);
	if (!repo) {
		documentHunks.delete(key);
		clearDecorationsFor(document.uri);
		codeLensEmitter.fire();
		updateStatusBar();
		return;
	}

	let patch: string;
	try {
		patch = await repo.diffWithHEAD(document.uri.fsPath);
	} catch {
		patch = '';
	}

	const accepted = acceptedSignatures.get(key);
	const hunks = parseHunks(patch, document.uri, document.fileName).filter(h => !accepted?.has(h.signature));
	documentHunks.set(key, hunks);

	const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === key);
	if (editor) {
		const ranges = hunks.flatMap(h => h.decorationRanges.map(r => new vscode.Range(r.start, 0, r.end, 0)));
		editor.setDecorations(decorationType, ranges);
	}

	codeLensEmitter.fire();
	updateStatusBar();
}

function clearDecorationsFor(uri: vscode.Uri) {
	const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
	if (editor) {
		editor.setDecorations(decorationType, []);
	}
}

function updateStatusBar() {
	const editor = vscode.window.activeTextEditor;
	const hunks = editor ? documentHunks.get(editor.document.uri.toString()) ?? [] : [];
	if (!editor || hunks.length === 0) {
		statusPrev.hide();
		statusCount.hide();
		statusNext.hide();
		return;
	}
	const position = currentIndex >= 0 ? currentIndex + 1 : 0;
	statusCount.text = `${position}/${hunks.length} changes`;
	statusPrev.show();
	statusCount.show();
	statusNext.show();
}

/**
 * Parses a `git diff`-style patch for a single file into per-hunk info, including a
 * standalone single-hunk patch (file preamble + one hunk) usable with `repo.apply(..., true)`
 * to reverse just that hunk.
 */
function parseHunks(patch: string, uri: vscode.Uri, fileName: string): Hunk[] {
	const hunks: Hunk[] = [];
	if (!patch) {
		return hunks;
	}
	const lines = patch.split('\n');
	const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
	const firstHunkIdx = lines.findIndex(l => hunkHeaderRe.test(l));
	if (firstHunkIdx === -1) {
		return hunks;
	}
	let preambleLines = lines.slice(0, firstHunkIdx);
	if (preambleLines.length === 0) {
		// Some git versions omit the `diff --git` preamble for diffWithHEAD(path); synthesize a minimal one.
		const relPath = vscode.workspace.asRelativePath(uri, false) || fileName;
		preambleLines = [
			`diff --git a/${relPath} b/${relPath}`,
			`--- a/${relPath}`,
			`+++ b/${relPath}`,
		];
	}

	let i = firstHunkIdx;
	while (i < lines.length) {
		const match = hunkHeaderRe.exec(lines[i]);
		if (!match) {
			i++;
			continue;
		}
		const headerLine = lines[i];
		let newLine = parseInt(match[1], 10);
		i++;
		const bodyLines: string[] = [];
		const addedLines: number[] = [];
		while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
			const line = lines[i];
			bodyLines.push(line);
			if (line.startsWith('+') && !line.startsWith('+++')) {
				addedLines.push(newLine);
				newLine++;
			} else if (line.startsWith('-') && !line.startsWith('---')) {
				// Deletion: doesn't correspond to a line in the current file.
			} else {
				newLine++;
			}
			i++;
		}
		// Drop a trailing empty-string artifact from splitting a patch that ends in '\n'.
		while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
			bodyLines.pop();
		}

		let startLine: number, endLine: number;
		const decorationRanges: LineRange[] = [];
		if (addedLines.length > 0) {
			startLine = addedLines[0] - 1;
			endLine = addedLines[addedLines.length - 1] - 1;
			for (const n of addedLines) {
				const zeroIdx = n - 1;
				const last = decorationRanges[decorationRanges.length - 1];
				if (last && last.end === zeroIdx - 1) {
					last.end = zeroIdx;
				} else {
					decorationRanges.push({ start: zeroIdx, end: zeroIdx });
				}
			}
		} else {
			// Pure deletion: anchor on the line it was removed in front of; nothing to highlight.
			startLine = Math.max(newLine - 1, 0);
			endLine = startLine;
		}

		hunks.push({
			startLine,
			endLine,
			decorationRanges,
			signature: headerLine,
			patchText: [...preambleLines, headerLine, ...bodyLines].join('\n') + '\n',
		});
	}
	return hunks;
}

function moveToChange(direction: 1 | -1) {
	const editor = vscode.window.activeTextEditor;
	const hunks = editor ? documentHunks.get(editor.document.uri.toString()) ?? [] : [];
	if (!editor || hunks.length === 0) {
		vscode.window.setStatusBarMessage('No git changes in this file', 2000);
		return;
	}
	currentIndex = (currentIndex + direction + hunks.length) % hunks.length;
	const hunk = hunks[currentIndex];
	const position = new vscode.Position(hunk.startLine, 0);
	editor.selection = new vscode.Selection(position, position);
	editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
	updateStatusBar();
}

async function acceptHunk(uri: vscode.Uri, signature: string) {
	const key = uri.toString();
	const set = acceptedSignatures.get(key) ?? new Set<string>();
	set.add(signature);
	acceptedSignatures.set(key, set);
	const document = await vscode.workspace.openTextDocument(uri);
	await refreshDocument(document);
}

async function rejectHunk(uri: vscode.Uri, signature: string) {
	if (!gitApi) {
		return;
	}
	const key = uri.toString();
	const hunks = documentHunks.get(key) ?? [];
	const hunk = hunks.find(h => h.signature === signature);
	if (!hunk) {
		return;
	}
	const document = await vscode.workspace.openTextDocument(uri);
	if (document.isDirty) {
		vscode.window.showWarningMessage('Git Change Highlighter: save the file before rejecting a change.');
		return;
	}
	const repo = gitApi.getRepository(uri);
	if (!repo) {
		return;
	}

	// Repository.apply expects a path to a patch *file*, not the patch text itself.
	const patchFile = vscode.Uri.file(path.join(os.tmpdir(), `git-change-highlighter-${randomUUID()}.patch`));
	try {
		await vscode.workspace.fs.writeFile(patchFile, Buffer.from(hunk.patchText, 'utf8'));
		await repo.apply(patchFile.fsPath, true);
	} catch (err) {
		vscode.window.showErrorMessage(`Git Change Highlighter: failed to reject change (${String(err)})`);
		return;
	} finally {
		await vscode.workspace.fs.delete(patchFile, { useTrash: false }).then(undefined, () => undefined);
	}

	const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === key);
	if (editor === vscode.window.activeTextEditor) {
		await vscode.commands.executeCommand('workbench.action.files.revert');
	}
	const freshDocument = await vscode.workspace.openTextDocument(uri);
	await refreshDocument(freshDocument);
}

export function deactivate() {}
