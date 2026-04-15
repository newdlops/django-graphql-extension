import * as vscode from 'vscode';
import { SchemaTreeItem } from './schemaTreeItem';
import { SchemaInfo, ClassInfo } from '../types';
import { detectProjects } from '../scanner/djangoDetector';
import { parseGrapheneSchemas } from '../scanner/grapheneParser';
import { parseStrawberrySchemas } from '../scanner/strawberryParser';
import { parseAriadneSchemas } from '../scanner/ariadneParser';
import { parseGraphQLFiles } from '../scanner/graphqlFileParser';
import { log } from '../logger';
import { ParseCache } from '../scanner/parseCache';

export class SchemaTreeProvider implements vscode.TreeDataProvider<SchemaTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SchemaTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private schemas: SchemaInfo[] = [];
  private classMap = new Map<string, ClassInfo>();
  private refreshing = false;
  private pendingRefresh = false;
  private filterPattern: RegExp | null = null;

  constructor(private cache: ParseCache) {}

  get activeFilter(): string | null {
    return this.filterPattern ? this.filterPattern.source : null;
  }

  setFilter(query: string, opts?: { caseSensitive?: boolean; wholeWord?: boolean; useRegex?: boolean }): void {
    if (!query) {
      this.clearFilter();
      return;
    }
    const caseSensitive = opts?.caseSensitive ?? false;
    const wholeWord = opts?.wholeWord ?? false;
    const useRegex = opts?.useRegex ?? false;
    const flags = caseSensitive ? '' : 'i';

    let source = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wholeWord) {
      source = `\\b${source}\\b`;
    }

    try {
      this.filterPattern = new RegExp(source, flags);
    } catch {
      this.filterPattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    }
    vscode.commands.executeCommand('setContext', 'djangoGraphqlExplorer.hasFilter', true);
    this._onDidChangeTreeData.fire(undefined);
  }

  clearFilter(): void {
    this.filterPattern = null;
    vscode.commands.executeCommand('setContext', 'djangoGraphqlExplorer.hasFilter', false);
    this._onDidChangeTreeData.fire(undefined);
  }

  private filterClasses(classes: ClassInfo[]): ClassInfo[] {
    if (!this.filterPattern) return classes;
    return classes.filter(
      (cls) => this.filterPattern!.test(cls.name) || cls.fields.some((f) => this.filterPattern!.test(f.name)),
    );
  }

  getTreeItem(element: SchemaTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SchemaTreeItem): SchemaTreeItem[] {
    if (!element) {
      if (this.schemas.length === 0) {
        return [
          new SchemaTreeItem(
            'No GraphQL schema found',
            vscode.TreeItemCollapsibleState.None,
            'category',
          ),
        ];
      }
      return this.getRootItems();
    }

    // Lazy-load resolved type fields
    if (element.resolvedTypeName) {
      const resolvedClass = this.classMap.get(element.resolvedTypeName);
      if (resolvedClass) {
        return resolvedClass.fields.map(
          (f) =>
            new SchemaTreeItem(
              f.name,
              vscode.TreeItemCollapsibleState.None,
              'field',
              f.filePath || resolvedClass.filePath,
              f.lineNumber,
              undefined,
              f.fieldType,
            ),
        );
      }
      return [];
    }

    return element.children ?? [];
  }

  private getRootItems(): SchemaTreeItem[] {
    const items: SchemaTreeItem[] = [];

    if (this.filterPattern) {
      items.push(
        new SchemaTreeItem(
          `Filter: /${this.filterPattern.source}/${this.filterPattern.flags}`,
          vscode.TreeItemCollapsibleState.None,
          'filter',
        ),
      );
    }

    for (const schema of this.schemas) {
      const categories = this.buildCategoryItems(schema);
      if (this.filterPattern && categories.length === 0) continue;
      items.push(new SchemaTreeItem(
        schema.name,
        categories.length > 0
          ? (this.filterPattern ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
          : vscode.TreeItemCollapsibleState.None,
        'schema',
        schema.filePath,
        undefined,
        categories,
      ));
    }

    return items;
  }

  private buildCategoryItems(schema: SchemaInfo): SchemaTreeItem[] {
    const items: SchemaTreeItem[] = [];
    const expandState = this.filterPattern
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;

    const filteredQueries = this.filterClasses(schema.queries);
    if (filteredQueries.length > 0) {
      const classItems = filteredQueries.map((cls) => this.buildClassItem(cls));
      items.push(
        new SchemaTreeItem(
          'Queries',
          expandState,
          'category',
          undefined,
          undefined,
          classItems,
          `(${classItems.length})`,
        ),
      );
    }

    const filteredMutations = this.filterClasses(schema.mutations);
    if (filteredMutations.length > 0) {
      const classItems = filteredMutations.map((cls) => this.buildClassItem(cls));
      items.push(
        new SchemaTreeItem(
          'Mutations',
          expandState,
          'category',
          undefined,
          undefined,
          classItems,
          `(${classItems.length})`,
        ),
      );
    }

    const filteredSubscriptions = this.filterClasses(schema.subscriptions);
    if (filteredSubscriptions.length > 0) {
      const classItems = filteredSubscriptions.map((cls) => this.buildClassItem(cls));
      items.push(
        new SchemaTreeItem(
          'Subscriptions',
          expandState,
          'category',
          undefined,
          undefined,
          classItems,
          `(${classItems.length})`,
        ),
      );
    }

    const filteredTypes = this.filterClasses(schema.types);
    if (filteredTypes.length > 0) {
      const classItems = filteredTypes.map((cls) => this.buildClassItem(cls));
      items.push(
        new SchemaTreeItem(
          'Types',
          expandState,
          'category',
          undefined,
          undefined,
          classItems,
          `(${classItems.length})`,
        ),
      );
    }

    return items;
  }

  private buildClassItem(cls: ClassInfo): SchemaTreeItem {
    const fieldItems = cls.fields.map((field) => {
      const hasResolved = field.resolvedType
        ? this.classMap.has(field.resolvedType)
        : false;

      return new SchemaTreeItem(
        field.name,
        hasResolved
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        'field',
        field.filePath || cls.filePath,
        field.lineNumber,
        undefined,
        field.fieldType + (field.resolvedType ? ` -> ${field.resolvedType}` : ''),
        hasResolved ? field.resolvedType : undefined,
      );
    });

    return new SchemaTreeItem(
      cls.name,
      fieldItems.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
      'class',
      cls.filePath,
      cls.lineNumber,
      fieldItems,
      `(${fieldItems.length})`,
    );
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.pendingRefresh = true;
      return;
    }
    this.refreshing = true;
    try {
      await this.doRefresh();
    } finally {
      this.refreshing = false;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        this.refresh();
      }
    }
  }

  private async doRefresh(): Promise<void> {
    const projects = await detectProjects();

    if (projects.length === 0) {
      this.schemas = [];
      vscode.commands.executeCommand('setContext', 'djangoGraphqlExplorer.hasProject', false);
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    const allSchemas: SchemaInfo[] = [];

    for (const project of projects) {
      const parsers: Promise<SchemaInfo[]>[] = [];

      for (const framework of project.frameworks) {
        switch (framework) {
          case 'graphene':
            parsers.push(parseGrapheneSchemas(project.rootDir, this.cache));
            break;
          case 'strawberry':
            parsers.push(parseStrawberrySchemas(project.rootDir));
            break;
          case 'ariadne':
            parsers.push(parseAriadneSchemas(project.rootDir));
            break;
          case 'graphql-schema':
            parsers.push(parseGraphQLFiles(project.rootDir));
            break;
        }
      }

      const results = await Promise.all(parsers);
      for (const schemas of results) {
        allSchemas.push(...schemas);
      }
    }

    // Build global class map for field type resolution
    this.classMap.clear();
    for (const schema of allSchemas) {
      for (const cls of [...schema.queries, ...schema.mutations, ...schema.subscriptions, ...schema.types]) {
        for (const field of cls.fields) {
          if (!field.filePath) {
            field.filePath = cls.filePath;
          }
        }
        this.classMap.set(cls.name, cls);
      }
    }

    this.schemas = allSchemas;

    log(`[treeProvider] === SCHEMAS (${allSchemas.length}) ===`);
    for (const schema of allSchemas) {
      log(`[treeProvider]   ${schema.name} (${schema.filePath})`);
      log(`[treeProvider]     queries: ${schema.queries.length} [${schema.queries.map((c) => `${c.name}(${c.fields.length})`).join(', ')}]`);
      log(`[treeProvider]     mutations: ${schema.mutations.length} [${schema.mutations.map((c) => `${c.name}(${c.fields.length})`).join(', ')}]`);
      log(`[treeProvider]     types: ${schema.types.length}`);
    }

    const hasContent = allSchemas.length > 0;
    await vscode.commands.executeCommand('setContext', 'djangoGraphqlExplorer.hasProject', hasContent);
    this._onDidChangeTreeData.fire(undefined);
  }
}
