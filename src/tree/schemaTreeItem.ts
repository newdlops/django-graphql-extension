import * as vscode from 'vscode';

export type SchemaTreeItemKind = 'schema' | 'category' | 'class' | 'field' | 'filter';

export class SchemaTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: SchemaTreeItemKind,
    public readonly filePath?: string,
    public readonly lineNum?: number,
    public readonly children?: SchemaTreeItem[],
    description?: string,
    public readonly resolvedTypeName?: string,
  ) {
    super(label, collapsibleState);

    this.description = description;

    if (filePath !== undefined && lineNum !== undefined) {
      this.command = {
        command: 'vscode.open',
        title: 'Open Definition',
        arguments: [
          vscode.Uri.file(filePath),
          {
            selection: new vscode.Range(lineNum, 0, lineNum, 0),
          },
        ],
      };
      this.tooltip = `${filePath}:${lineNum + 1}`;
    }

    switch (kind) {
      case 'schema':
        this.iconPath = new vscode.ThemeIcon('symbol-package');
        this.contextValue = 'schema';
        break;
      case 'category':
        this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        this.contextValue = 'category';
        break;
      case 'class':
        this.iconPath = new vscode.ThemeIcon('symbol-class');
        this.contextValue = 'class';
        break;
      case 'field':
        this.iconPath = new vscode.ThemeIcon('symbol-field');
        this.contextValue = 'field';
        break;
      case 'filter':
        this.iconPath = new vscode.ThemeIcon('search');
        this.contextValue = 'filterStatus';
        break;
    }
  }
}
