import * as vscode from 'vscode';

export interface SearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export class SearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'djangoGraphqlExplorer.search';

  private view?: vscode.WebviewView;
  private onDidChangeSearch: (state: SearchState) => void;

  constructor(onDidChangeSearch: (state: SearchState) => void) {
    this.onDidChangeSearch = onDidChangeSearch;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage((msg: SearchState) => {
      this.onDidChangeSearch(msg);
    });
  }

  private getHtml(): string {
    return /*html*/ `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    padding: 4px 4px 4px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: transparent;
  }
  .search-row {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    padding: 0 2px;
  }
  .search-row:focus-within {
    border-color: var(--vscode-focusBorder);
  }
  input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    padding: 3px 4px;
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-input-foreground);
    background: transparent;
  }
  input::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-foreground);
    opacity: 0.6;
    background: transparent;
    flex-shrink: 0;
  }
  .toggle:hover {
    opacity: 0.9;
    background: var(--vscode-toolbar-hoverBackground);
  }
  .toggle.active {
    opacity: 1;
    background: var(--vscode-inputOption-activeBackground, rgba(0,90,180,0.3));
    border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
    color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
  }
  .count {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    padding: 0 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }
</style>
</head>
<body>
  <div class="search-row">
    <input id="q" type="text" placeholder="Search queries, mutations..." spellcheck="false" />
    <button class="toggle" id="case" title="Match Case (Alt+C)">Aa</button>
    <button class="toggle" id="word" title="Match Whole Word (Alt+W)"><b>ab</b>|</button>
    <button class="toggle" id="regex" title="Use Regular Expression (Alt+R)">.*</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('q');
    const caseBtn = document.getElementById('case');
    const wordBtn = document.getElementById('word');
    const regexBtn = document.getElementById('regex');

    let state = { query: '', caseSensitive: false, wholeWord: false, useRegex: false };

    function emit() {
      state.query = input.value;
      vscode.postMessage(state);
    }

    function toggleBtn(btn, key) {
      state[key] = !state[key];
      btn.classList.toggle('active', state[key]);
      emit();
    }

    input.addEventListener('input', emit);
    caseBtn.addEventListener('click', () => toggleBtn(caseBtn, 'caseSensitive'));
    wordBtn.addEventListener('click', () => toggleBtn(wordBtn, 'wholeWord'));
    regexBtn.addEventListener('click', () => toggleBtn(regexBtn, 'useRegex'));

    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'c') { toggleBtn(caseBtn, 'caseSensitive'); e.preventDefault(); }
      if (e.altKey && e.key === 'w') { toggleBtn(wordBtn, 'wholeWord'); e.preventDefault(); }
      if (e.altKey && e.key === 'r') { toggleBtn(regexBtn, 'useRegex'); e.preventDefault(); }
    });

    input.focus();
  </script>
</body>
</html>`;
  }
}
