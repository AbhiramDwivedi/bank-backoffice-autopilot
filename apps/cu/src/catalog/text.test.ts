/** apps/cu/src/catalog/text.ts: tokenizer, stemmer, and the one-line description rule. */
import { describe, expect, it } from 'vitest';
import { ONE_LINE_MAX, oneLineDescription, rawTokens, stem, tokenize } from './text.js';

describe('rawTokens', () => {
  it('splits kebab-case, snake_case, camelCase and punctuation, lower-cased', () => {
    expect(rawTokens('lookup-member-savings-balance')).toEqual(['lookup', 'member', 'savings', 'balance']);
    expect(rawTokens('lookup_member_savings_balance')).toEqual(['lookup', 'member', 'savings', 'balance']);
    expect(rawTokens('savingsBalance')).toEqual(['savings', 'balance']);
    expect(rawTokens('memberID')).toEqual(['member', 'id']);
    expect(rawTokens('parseHTMLPage')).toEqual(['parse', 'html', 'page']);
    expect(rawTokens("Member's balance, (USD)!")).toEqual(['member', 'balance', 'usd']);
  });

  it('drops stop words and single characters, keeps digits', () => {
    expect(rawTokens('Look up the balance of a member')).toEqual(['look', 'up', 'balance', 'member']);
    expect(rawTokens('form 1099 q')).toEqual(['form', '1099']);
  });

  it('returns nothing for text with no words', () => {
    expect(rawTokens('')).toEqual([]);
    expect(rawTokens('the of and')).toEqual([]);
    expect(rawTokens('--- ...')).toEqual([]);
  });
});

describe('stem', () => {
  it('folds plurals onto the singular', () => {
    expect(stem('balances')).toBe(stem('balance'));
    expect(stem('members')).toBe('member');
    expect(stem('accounts')).toBe('account');
    expect(stem('boxes')).toBe('box');
    expect(stem('searches')).toBe('search');
    expect(stem('addresses')).toBe('address');
    expect(stem('parties')).toBe(stem('party'));
    expect(stem('ids')).toBe('id');
    for (const [plural, singular] of [['visas', 'visa'], ['areas', 'area'], ['quotas', 'quota']] as const) expect(stem(plural)).toBe(stem(singular));
  });

  it('does NOT merge -ing/-ed forms: "savings" stays apart from "save", "checking" from "check"', () => {
    expect(stem('savings')).not.toBe(stem('save'));
    expect(stem('checking')).not.toBe(stem('check'));
    expect(stem('added')).toBe('added');
    expect(stem('running')).toBe('running');
    expect(stem('saving')).toBe('saving');
  });

  it('leaves words that merely look plural alone', () => {
    expect(stem('status')).toBe('status');
    expect(stem('access')).toBe('access');
    expect(stem('analysis')).toBe('analysis');
    expect(stem('gas')).toBe('gas');
    expect(stem('has')).toBe('has');
    expect(stem('id')).toBe('id');
    expect(stem('v2s')).toBe('v2s'); // digits: untouched
    expect(stem('1099')).toBe('1099');
  });

  it('is applied by tokenize after splitting', () => {
    expect(tokenize('savingsBalance')).toEqual([stem('savings'), stem('balance')]);
    expect(tokenize('Balances')).toEqual(tokenize('balance'));
  });
});

describe('unicode', () => {
  it('keeps accented letters inside words instead of splitting on them', () => {
    expect(rawTokens('Müller café')).toEqual(['müller', 'café']);
    expect(rawTokens('Zoë-Ångström')).toEqual(['zoë', 'ångström']);
    expect(rawTokens('niñoCuenta')).toEqual(['niño', 'cuenta']); // camelCase split works on non-ASCII lower case
    expect(rawTokens('ÉcoleMaternelle')).toEqual(['école', 'maternelle']);
  });

  it('NFKC-normalises: decomposed accents and full-width forms equal their composed forms', () => {
    expect(rawTokens('café')).toEqual(rawTokens('café'));
    expect(rawTokens('ＢＡＬＡＮＣＥ')).toEqual(['balance']);
  });

  it('keeps a CJK run as one token (no segmentation) rather than dropping it', () => {
    expect(rawTokens('口座残高 照会')).toEqual(['口座残高', '照会']);
  });
});

describe('oneLineDescription', () => {
  it('takes the first sentence', () => {
    expect(oneLineDescription('Looks up a member. Then it returns the balance.')).toBe('Looks up a member.');
    expect(oneLineDescription('Is it done? Yes.')).toBe('Is it done?');
    expect(oneLineDescription('No terminator here')).toBe('No terminator here');
  });

  it('collapses whitespace and newlines', () => {
    expect(oneLineDescription('  Signs on,\n   searches   for a member.\nMore text. ')).toBe('Signs on, searches for a member.');
  });

  it('does not end the sentence at an initial or a common abbreviation', () => {
    expect(oneLineDescription('Returns the profile for Jane Q. Sample and her balance. Extra.')).toBe(
      'Returns the profile for Jane Q. Sample and her balance.',
    );
    expect(oneLineDescription('Handles fees, e.g. wire fees. Other.')).toBe('Handles fees, e.g. wire fees.');
  });

  it('keeps a period inside a number or version', () => {
    expect(oneLineDescription('Targets build 7.4.2 of the workstation. Done.')).toBe('Targets build 7.4.2 of the workstation.');
  });

  it('truncates an over-long sentence at a word boundary with "..."', () => {
    const long = 'Signs on to the workstation and then searches for a member by their numeric member identifier before opening the profile tab and reading the current balance';
    const out = oneLineDescription(long);
    expect(out.length).toBeLessThanOrEqual(ONE_LINE_MAX);
    expect(out.endsWith('...')).toBe(true);
    expect(long.startsWith(out.slice(0, -3))).toBe(true);
    expect(out.slice(0, -3).endsWith(' ')).toBe(false);
    expect(long[out.length - 3]).toBe(' '); // cut on a word boundary
    expect(oneLineDescription(long, 20)).toBe('Signs on to the...');
  });

  it('requires whitespace plus an upper-case letter or digit after the period to end a sentence', () => {
    expect(oneLineDescription('Reads the file.json export. Then stops.')).toBe('Reads the file.json export.');
    expect(oneLineDescription('Sends it. then lower case continues. Next.')).toBe('Sends it. then lower case continues.');
    expect(oneLineDescription('Runs v2. 3 retries follow.')).toBe('Runs v2.');
  });

  it('does not end at Dr. / U.S.', () => {
    expect(oneLineDescription('Asks Dr. Smith to approve. Done.')).toBe('Asks Dr. Smith to approve.');
    expect(oneLineDescription('Files with the U.S. Treasury today. Done.')).toBe('Files with the U.S. Treasury today.');
  });

  it('never exceeds max, including when max is under 4', () => {
    expect(oneLineDescription('Hello world.', 3)).toBe('Hel');
    expect(oneLineDescription('Hello world.', 1)).toBe('H');
    expect(oneLineDescription('Hello world.', 0)).toBe('');
    for (let max = 0; max <= 12; max += 1) expect(oneLineDescription('Hello wonderful world of capabilities.', max).length).toBeLessThanOrEqual(max);
  });

  it('hard-cuts a single over-long word', () => {
    expect(oneLineDescription('x'.repeat(50), 10)).toBe(`${'x'.repeat(7)}...`);
  });

  it('is deterministic and never exceeds max', () => {
    const d = 'A. B. C. '.repeat(40);
    expect(oneLineDescription(d)).toBe(oneLineDescription(d));
    expect(oneLineDescription('word '.repeat(100)).length).toBeLessThanOrEqual(ONE_LINE_MAX);
  });
});
