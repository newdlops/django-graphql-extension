import { describe, expect, it } from 'vitest';
import { isExplorerToHostMessage, isLazyExpandMessage } from '../../webview/protocol';

describe('webview protocol guards', () => {
  it('accepts only bounded, typed Explorer actions', () => {
    expect(isExplorerToHostMessage({ type: 'search', query: 'User', caseSensitive: false, wholeWord: false, useRegex: false })).toBe(true);
    expect(isExplorerToHostMessage({ type: 'search', query: 3, caseSensitive: false, wholeWord: false, useRegex: false })).toBe(false);
    expect(isExplorerToHostMessage({ type: 'sort', mode: 'drop table' })).toBe(false);
    expect(isExplorerToHostMessage({ type: 'open', file: '/workspace/schema.py', line: -1 })).toBe(false);
  });

  it('rejects malformed lazy messages before a host can resolve a type', () => {
    expect(isLazyExpandMessage({ type: 'expandType', requestId: 'r1', nodeId: 'n1', typeName: 'User', ancestry: ['Query'], depth: 2 })).toBe(true);
    expect(isLazyExpandMessage({ type: 'expandType', nodeId: 'n1', typeName: 'User', ancestry: [1] })).toBe(false);
    expect(isLazyExpandMessage({ type: 'expandType', nodeId: 'n1', typeName: '', ancestry: [] })).toBe(false);
  });
});
