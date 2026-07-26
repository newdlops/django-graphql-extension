import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import axe from 'axe-core';
import { GraphqlViewProvider } from '../../webview/graphqlViewProvider';
import { renderQueryStructureHtml } from '../../preview/queryStructureWebview';
import { buildQueryStructure } from '../../analysis/queryStructure';
import { parseGqlFields } from '../../codelens/gqlCodeLensProvider';

function mount(html: string): { dom: JSDOM; messages: unknown[] } {
  const messages: unknown[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi = () => ({
        postMessage: (message: unknown) => messages.push(message),
      });
    },
  });
  return { dom, messages };
}

describe('generated Webview accessibility contracts', () => {
  it('has no critical or serious axe violations in the explorer shell', async () => {
    const provider = new GraphqlViewProvider();
    const { dom } = mount((provider as unknown as { getHtml: () => string }).getHtml());
    const results = await axe.run(dom.window.document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')).toEqual([]);
  });

  it('has no critical or serious axe violations in Query Coverage', async () => {
    const profile = {
      name: 'ProfileType' as const, kind: 'type' as const, framework: 'graphene' as const,
      filePath: '/p.py', lineNumber: 0, baseClasses: [],
      fields: [
        { name: 'id', fieldType: 'ID', filePath: '/p.py', lineNumber: 1 },
        { name: 'email', fieldType: 'String', filePath: '/p.py', lineNumber: 2 },
      ],
    };
    const structure = buildQueryStructure(parseGqlFields('query { profile { id } }')[0], profile, new Map([[profile.name, profile]]));
    const { dom } = mount(renderQueryStructureHtml(structure));
    const results = await axe.run(dom.window.document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')).toEqual([]);
  });

  it('renders labeled explorer controls and semantic tree items', () => {
    const provider = new GraphqlViewProvider();
    const { dom, messages } = mount((provider as unknown as { getHtml: () => string }).getHtml());
    const { document, MessageEvent } = dom.window;

    expect(messages).toContainEqual({ type: 'ready', surface: 'explorer' });
    expect(document.querySelector('label[for="q"]')?.textContent).toContain('Search schema');
    expect(document.querySelector('#case')?.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('#sort')?.getAttribute('aria-label')).toBe('Sort results');

    dom.window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'tree',
        hasFilter: false,
        sortMode: 'none',
        sections: [{
          id: 'backend',
          label: 'Backend',
          desc: '1 class',
          emptyMessage: 'Empty',
          openByDefault: true,
          children: [{
            label: 'Query',
            desc: '1',
            kind: 'class',
            icon: 'symbol-class',
            classId: 'query',
            children: [{ label: 'viewer', kind: 'field', icon: 'symbol-field' }],
          }],
        }],
      },
    }));

    expect(document.querySelector('[role="tree"]')).not.toBeNull();
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
    expect(document.querySelector('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('uses a paged flat result list while searching', () => {
    const provider = new GraphqlViewProvider();
    const { dom } = mount((provider as unknown as { getHtml: () => string }).getHtml());
    const { document, MessageEvent } = dom.window;
    const children = Array.from({ length: 101 }, (_, index) => ({
      label: `Field${index}`,
      kind: 'field',
      icon: 'symbol-field',
      file: '/p/schema.py',
      line: index,
    }));

    dom.window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'tree',
        hasFilter: true,
        sortMode: 'none',
        sections: [{
          id: 'backend',
          label: 'Backend',
          desc: '101 classes',
          emptyMessage: 'Empty',
          openByDefault: true,
          children: [{ label: 'Query', kind: 'class', icon: 'symbol-class', classId: 'query', children }],
        }],
      },
    }));

    expect(document.querySelector('[role="tree"]')).toBeNull();
    expect(document.querySelector('[role="list"]')).not.toBeNull();
    expect(document.querySelectorAll('.search-result')).toHaveLength(100);
    expect(document.querySelector('.result-more')?.textContent).toContain('Show 100 more');
  });

  it('caps the default hierarchy mount and offers an explicit next page', () => {
    const provider = new GraphqlViewProvider();
    const { dom } = mount((provider as unknown as { getHtml: () => string }).getHtml());
    const { document, MessageEvent } = dom.window;
    const children = Array.from({ length: 301 }, (_, index) => ({
      label: `Type${index}`, kind: 'class', icon: 'symbol-class', classId: `type-${index}`, children: [],
    }));
    dom.window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'tree', hasFilter: false, sortMode: 'none', sections: [{
        id: 'backend', label: 'Backend', desc: '301 classes', emptyMessage: 'Empty', openByDefault: true, children,
      }] },
    }));

    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(299);
    expect(document.querySelector('.result-more')?.textContent).toContain('Show 100 more');
  });

  it('renders inspector controls semantically and limits the initial field DOM', () => {
    const provider = new GraphqlViewProvider();
    const { dom, messages } = mount((provider as unknown as { getInspectorShellHtml: () => string }).getInspectorShellHtml());
    const { document, MessageEvent } = dom.window;
    const fields = Array.from({ length: 101 }, (_, index) => ({
      name: `field_${index}`,
      displayName: `field${index}`,
      fieldType: 'String',
      args: [],
      filePath: '/p/schema.py',
      lineNumber: index,
      origin: 'own',
      queried: index === 0,
      resolvedTypeExists: false,
    }));

    expect(messages).toContainEqual({ type: 'ready', surface: 'inspector' });
    dom.window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'inspector',
        data: {
          className: 'Query',
          kind: 'query',
          filePath: '/p/schema.py',
          lineNumber: 0,
          baseClasses: [],
          knownBaseClasses: [],
          baseClassTargets: {},
          fields,
          queriedCount: 1,
          totalCount: fields.length,
          hasActiveCoverage: true,
          usedAsFieldType: [],
          usedAsArgType: [],
          sdl: 'type Query { viewer: String }',
        },
      },
    }));

    expect(document.querySelector('#field-search')?.getAttribute('type')).toBe('search');
    expect(document.querySelectorAll('.filter')).toHaveLength(5);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(100);
    expect(document.querySelector('#load-more')?.textContent).toContain('Show 100 more');
    expect(document.querySelector('.path')?.tagName).toBe('BUTTON');
  });

  it('keeps query-state filters hidden without an active operation context', () => {
    const provider = new GraphqlViewProvider();
    const { dom } = mount((provider as unknown as { getInspectorShellHtml: () => string }).getInspectorShellHtml());
    const { document, MessageEvent } = dom.window;
    dom.window.dispatchEvent(new MessageEvent('message', { data: { type: 'inspector', data: {
      className: 'Query', kind: 'query', filePath: '/p.py', lineNumber: 0, baseClasses: [], knownBaseClasses: [], baseClassTargets: {},
      fields: [], queriedCount: 0, totalCount: 0, hasActiveCoverage: false, usedAsFieldType: [], usedAsArgType: [], sdl: 'type Query',
    } } }));
    expect(document.querySelectorAll('.filter')).toHaveLength(3);
    expect(document.body.textContent).toContain('No active operation context');
  });
});
