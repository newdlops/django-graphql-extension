// Scenarios 7 & 8: snake_case ↔ camelCase mapping.

import { describe, it, expect } from 'vitest';
import { camelToSnake, snakeToCamel } from '../../codelens/gqlCodeLensProvider';

describe('camelToSnake (scenario 7 — simple)', () => {
  it('converts simple camelCase to snake_case', () => {
    expect(camelToSnake('userProfile')).toBe('user_profile');
    expect(camelToSnake('companyId')).toBe('company_id');
  });

  it('leaves already-snake_case strings unchanged', () => {
    expect(camelToSnake('user_profile')).toBe('user_profile');
    expect(camelToSnake('id')).toBe('id');
  });

  it('handles digits correctly', () => {
    expect(camelToSnake('field1Name')).toBe('field1_name');
  });
});

describe('camelToSnake (scenario 8 — consecutive capitals / acronyms)', () => {
  it('keeps an acronym together: HTTPStatus → http_status', () => {
    expect(camelToSnake('HTTPStatus')).toBe('http_status');
  });

  it('handles acronym in the middle: httpStatusCode → http_status_code', () => {
    expect(camelToSnake('httpStatusCode')).toBe('http_status_code');
  });

  it('handles acronym followed by PascalWord: parseHTTPResponse → parse_http_response', () => {
    expect(camelToSnake('parseHTTPResponse')).toBe('parse_http_response');
  });

  it('handles trailing acronym: responseURL → response_url', () => {
    expect(camelToSnake('responseURL')).toBe('response_url');
  });

  it('handles multiple acronyms: parseXMLHTTPRequest → parse_xmlhttp_request', () => {
    // Chained acronyms collapse into a single run — consistent with Python
    // stdlib `re.sub` conventions for this style of conversion.
    expect(camelToSnake('parseXMLHTTPRequest')).toBe('parse_xmlhttp_request');
  });

  it('mixes digits into camelCase identifiers: ipV4Address → ip_v4_address', () => {
    expect(camelToSnake('ipV4Address')).toBe('ip_v4_address');
  });
});

describe('snakeToCamel (scenario 7)', () => {
  it('converts snake_case to camelCase', () => {
    expect(snakeToCamel('user_profile')).toBe('userProfile');
    expect(snakeToCamel('created_at')).toBe('createdAt');
  });

  it('leaves already-camelCase strings unchanged', () => {
    expect(snakeToCamel('userProfile')).toBe('userProfile');
    expect(snakeToCamel('id')).toBe('id');
  });

  it('is inverse of camelToSnake for simple identifiers', () => {
    const roundtrip = ['userProfile', 'companyId', 'firstName', 'id'];
    for (const s of roundtrip) {
      expect(snakeToCamel(camelToSnake(s))).toBe(s);
    }
  });
});
