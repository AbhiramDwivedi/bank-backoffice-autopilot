/**
 * FakeSurface scenario mirroring the "CU Core Workstation" mock app (apps/mock-app/,
 * docs/design/mock-app.md). Screen ids and element ids/names here are the vocabulary the
 * hand-written example capability
 * (`artifacts/examples/lookup-member-savings-balance.example.json`) is written against, so avoid
 * renaming anything here without also updating that capability.
 *
 * Tenant A and B (apps/mock-app/tenant.ts) differ only in institution name, the member-id field's
 * label ("Member ID" vs. "Member #"), and shell kind (A: a real `<frameset>`; B: banner/nav
 * inlined into the top document, only "main" is a real frame) -- both still expose a frame named
 * "main", so every target/condition below works unchanged across tenants.
 *
 * The search button, the maintenance-modal "OK", and the result rows are modelled as plain
 * `role: 'clickable'` divs/trs with no ARIA role, matching the real markup: this is what makes
 * `getByRole('button'/'link')` fail against them, so role-based locators for those controls are
 * never authored in the example capability.
 */
import type { FramePath } from '../../schema/index.js';
import { el, FakeSurface, type FakeElementSpec, type FakeScenario, type FakeScreenSpec, type FakeSurfaceOptions, type TransitionContext, type TransitionRule, type TransitionTarget } from '../fake/index.js';

/** Which seeded tenant's mock app a scenario/surface models: `'a'` (frameset shell) or `'b'` (iframe shell). */
export type CuCoreTenant = 'a' | 'b';

/** Options for `createCuCoreScenario` and `createCuCoreSurface`: which tenant to model, and which optional fault/latency behavior to enable. */
export interface CreateCuCoreScenarioOptions {
  tenant?: CuCoreTenant;
  /** Default true: a maintenance interstitial is shown once after a successful sign-on. */
  interstitial?: boolean;
  latencyMs?: number;
  /** Default false: mirrors the `failSearch` fault -- submitting the member search always lands
   * on the `app_error` screen (mock-app's /members/search returns HTTP 500 while this is on). */
  failSearch?: boolean;
}

interface TenantConfig {
  base: string;
  institution: string;
  memberIdLabel: string;
  /** tenant A: real <frameset> (banner/nav/main all separate frames). tenant B: banner/nav
   * inlined into the top document; only "main" is a frame (an <iframe name="main">). */
  shell: 'frameset' | 'iframe';
}

const TENANT_CONFIG: Record<CuCoreTenant, TenantConfig> = {
  a: { base: 'http://localhost:4173', institution: 'Pioneer Valley Community CU', memberIdLabel: 'Member ID', shell: 'frameset' },
  b: { base: 'http://localhost:4174', institution: 'Riverbend Federal Credit Union', memberIdLabel: 'Member #', shell: 'iframe' },
};

const BANNER_FRAME: FramePath = [{ name: 'banner' }];
const NAV_FRAME: FramePath = [{ name: 'nav' }];
const MAIN_FRAME: FramePath = [{ name: 'main' }];
const TOP: FramePath = [];

interface SeedMember {
  name: string;
  savings: string;
  checking: string;
  joinDate: string;
  /** The search-results row's visible text: "<id> <fullName> <joinDate> Active", matching the
   * real column order in views/search.ejs (Member ID/Member #, Name, Joined, Status). */
  resultText: string;
}

const RESTRICTED_MEMBER_ID = '90001';

/** Values taken straight from apps/mock-app/data/seed.ts (formatCents/fullName applied by hand). */
function seedMember(id: string, name: string, savings: string, checking: string, joinDate: string): SeedMember {
  return { name, savings, checking, joinDate, resultText: `${id} ${name} ${joinDate} Active` };
}

const SEED_MEMBERS: Record<string, SeedMember> = {
  '12345': seedMember('12345', 'Jane Q. Sample', '$1,234.56', '$310.00', '08/15/2004'),
  '90001': seedMember('90001', 'Restricted X. Insider', '$9,999.99', '$999.99', '01/01/2000'),
  '10001': seedMember('10001', 'Harold T. Abernathy', '$4,822.10', '$915.44', '03/14/1994'),
  '10002': seedMember('10002', 'Denise M. Kowalczyk', '$12,500.00', '$430.18', '07/02/2001'),
  '10003': seedMember('10003', 'Marcus L. Oyelaran', '$75.33', '$22.10', '11/19/2008'),
};
const SEED_IDS: ReadonlySet<string> = new Set(Object.keys(SEED_MEMBERS));

function shellFrames(cfg: TenantConfig, mainUrl: string): { path: FramePath; url: string }[] {
  if (cfg.shell === 'frameset') {
    return [
      { path: BANNER_FRAME, url: `${cfg.base}/frames/banner` },
      { path: NAV_FRAME, url: `${cfg.base}/frames/nav` },
      { path: MAIN_FRAME, url: mainUrl },
    ];
  }
  // tenant B: banner/nav are inlined into the top document (workstation-iframe.ejs); only
  // "main" is a real frame.
  return [{ path: MAIN_FRAME, url: mainUrl }];
}

function shellElements(cfg: TenantConfig): FakeElementSpec[] {
  const bannerFrame = cfg.shell === 'frameset' ? BANNER_FRAME : TOP;
  const navFrame = cfg.shell === 'frameset' ? NAV_FRAME : TOP;
  // banner-inner.ejs renders the institution name and "CU Core Workstation 7.4.2" as two
  // separate <font> runs; textDigest concatenates them in that order.
  const bannerText = `${cfg.institution} CU Core Workstation 7.4.2`;
  return [
    el({ id: 'bannerText', role: 'generic', name: bannerText, text: bannerText, tag: 'div', frame: bannerFrame, bbox: { x: 0, y: 0, w: 1280, h: 70 } }),
    // nav-table.ejs: "Member Search" and "Log Off" are real working links. There is no
    // "Open Sub-Account" nav link in the real app (sub-accounts are opened from a link on the
    // detail page's Accounts tab, out of scope for G1); navOpenSubAccount's id is kept for API
    // stability but now models "Reports" (nav-table.ejs's other real, working link) instead.
    el({ id: 'navMemberSearch', role: 'link', name: 'Member Search', tag: 'a', frame: navFrame, bbox: { x: 10, y: 10, w: 150, h: 20 } }),
    el({ id: 'navOpenSubAccount', role: 'link', name: 'Reports', tag: 'a', frame: navFrame, bbox: { x: 10, y: 40, w: 150, h: 20 } }),
    el({ id: 'navSignOff', role: 'link', name: 'Log Off', tag: 'a', frame: navFrame, bbox: { x: 10, y: 70, w: 150, h: 20 } }),
  ];
}

function searchFormElements(memberIdLabel: string, hidden = false): FakeElementSpec[] {
  return [
    // search.ejs: <h2><%= tenant.institution %> &mdash; Member Search</h2>
    el({ id: 'memberSearchHeading', role: 'heading', name: 'Member Search', text: `Member Search`, tag: 'h2', frame: MAIN_FRAME, hidden, bbox: { x: 220, y: 100, w: 300, h: 28 } }),
    // Label cell text is the tenant label verbatim, no trailing colon (unlike the login page).
    el({ id: 'memberIdLabel', role: 'cell', name: memberIdLabel, text: memberIdLabel, tag: 'td', row: 'r-mid', frame: MAIN_FRAME, hidden, bbox: { x: 220, y: 150, w: 100, h: 24 } }),
    el({
      id: 'memberId',
      role: 'textbox',
      name: memberIdLabel,
      label: memberIdLabel,
      tag: 'input',
      css: ['input[name=memberId]'],
      row: 'r-mid',
      frame: MAIN_FRAME,
      hidden,
      bbox: { x: 330, y: 150, w: 150, h: 24 },
    }),
    el({ id: 'lastNameLabel', role: 'cell', name: 'Last Name', text: 'Last Name', tag: 'td', row: 'r-ln', frame: MAIN_FRAME, hidden, bbox: { x: 220, y: 180, w: 100, h: 24 } }),
    el({
      id: 'lastName',
      role: 'textbox',
      name: 'Last Name',
      label: 'Last Name',
      tag: 'input',
      css: ['input[name=lastName]'],
      row: 'r-ln',
      frame: MAIN_FRAME,
      hidden,
      bbox: { x: 330, y: 180, w: 150, h: 24 },
    }),
    // search.ejs: <div class="btn" onclick="doSearch()">Search</div> -- a plain div, no ARIA
    // role, sitting next to an equally plain "Clear" div.btn; role is deliberately synthetic
    // ('clickable') so a role-based locator can't find it (see the file header).
    el({
      id: 'search',
      role: 'clickable',
      name: 'Search',
      text: 'Search',
      tag: 'div',
      css: ['div.btn[onclick^="doSearch"]'],
      frame: MAIN_FRAME,
      hidden,
      bbox: { x: 330, y: 214, w: 80, h: 28 },
    }),
  ];
}

function loginElements(): FakeElementSpec[] {
  return [
    // login.ejs: legacy table layout, label cells read "User ID:" / "Password:" (trailing
    // colon) immediately to the left of each input, no <label for>.
    el({ id: 'userIdLabel', role: 'cell', name: 'User ID', text: 'User ID:', tag: 'td', row: 'r-user', bbox: { x: 400, y: 300, w: 100, h: 24 } }),
    el({
      id: 'userId',
      role: 'textbox',
      name: 'User ID',
      label: 'User ID:',
      tag: 'input',
      css: ['input[name=userId]'],
      row: 'r-user',
      bbox: { x: 510, y: 300, w: 150, h: 24 },
    }),
    el({ id: 'passwordLabel', role: 'cell', name: 'Password', text: 'Password:', tag: 'td', row: 'r-pass', bbox: { x: 400, y: 330, w: 100, h: 24 } }),
    el({
      id: 'password',
      role: 'textbox',
      name: 'Password',
      label: 'Password:',
      tag: 'input',
      inputType: 'password',
      css: ['input[name=password]'],
      row: 'r-pass',
      bbox: { x: 510, y: 330, w: 150, h: 24 },
    }),
    // login.ejs: <input type="image" src="/static/img/btn_login.gif" name="login"> -- no alt
    // text at all, so its accessible name falls back to the `name` attribute, "login". Its ARIA
    // role IS real (an <input type=image> is an implicit button), unlike the search/maint-OK
    // divs; there is no visible text to anchor a `text` locator on.
    el({ id: 'signOn', role: 'button', name: 'login', tag: 'input', css: ['input[name=login]', 'input[type=image]'], bbox: { x: 510, y: 364, w: 90, h: 30 } }),
  ];
}

function buildLoginScreen(cfg: TenantConfig, error?: string): Omit<FakeScreenSpec, 'id'> {
  const elements = loginElements();
  if (error !== undefined) {
    elements.push(el({ id: 'loginError', role: 'generic', name: error, text: error, tag: 'font', bbox: { x: 400, y: 260, w: 300, h: 24 } }));
  }
  return { url: `${cfg.base}/login`, title: `${cfg.institution} - CU Core Workstation - Login`, elements };
}

function buildWorkstationScreen(cfg: TenantConfig): Omit<FakeScreenSpec, 'id'> {
  return {
    url: `${cfg.base}/workstation`,
    title: `${cfg.institution} - CU Core Workstation`,
    frames: shellFrames(cfg, `${cfg.base}/members/search`),
    elements: [...shellElements(cfg), ...searchFormElements(cfg.memberIdLabel)],
  };
}

function buildWorkstationNoticeScreen(cfg: TenantConfig): Omit<FakeScreenSpec, 'id'> {
  return {
    url: `${cfg.base}/workstation`,
    title: `${cfg.institution} - CU Core Workstation`,
    frames: shellFrames(cfg, `${cfg.base}/members/search`),
    elements: [
      ...shellElements(cfg),
      ...searchFormElements(cfg.memberIdLabel, true),
      // partials/interstitial.ejs, verbatim.
      el({
        id: 'maintTitle',
        role: 'generic',
        name: 'System Maintenance Notice',
        text: 'System Maintenance Notice',
        tag: 'div',
        frame: MAIN_FRAME,
        bbox: { x: 400, y: 300, w: 400, h: 30 },
      }),
      el({
        id: 'maintBody',
        role: 'generic',
        name: 'Scheduled maintenance Sunday 02:00–04:00 ET. Some functions may be unavailable.',
        text: 'Scheduled maintenance Sunday 02:00–04:00 ET. Some functions may be unavailable.',
        tag: 'div',
        frame: MAIN_FRAME,
        bbox: { x: 400, y: 330, w: 400, h: 40 },
      }),
      el({ id: 'maintOk', role: 'clickable', name: 'OK', text: 'OK', tag: 'div', css: ['div.maint-ok'], frame: MAIN_FRAME, bbox: { x: 560, y: 380, w: 80, h: 30 } }),
    ],
  };
}

function buildSearchEmptyScreen(cfg: TenantConfig): Omit<FakeScreenSpec, 'id'> {
  return {
    url: `${cfg.base}/workstation`,
    title: `${cfg.institution} - CU Core Workstation`,
    frames: shellFrames(cfg, `${cfg.base}/members/search`),
    elements: [
      ...shellElements(cfg),
      ...searchFormElements(cfg.memberIdLabel),
      // search.ejs always renders "<N> record(s) found" above the results table, even at 0.
      el({ id: 'searchEmptyCount', role: 'generic', name: '0 record(s) found', text: '0 record(s) found', tag: 'p', frame: MAIN_FRAME, bbox: { x: 220, y: 220, w: 200, h: 20 } }),
      // search.ejs: <td class="msg">No records found.</td> (td.msg{color:#FF0000} in the same view).
      el({ id: 'noRecordsMsg', role: 'cell', name: 'No records found.', text: 'No records found.', tag: 'td', css: ['td.msg'], frame: MAIN_FRAME, bbox: { x: 220, y: 250, w: 300, h: 24 } }),
    ],
  };
}

function buildSearchResultsScreen(cfg: TenantConfig, id: string, member: SeedMember): Omit<FakeScreenSpec, 'id'> {
  return {
    url: `${cfg.base}/workstation`,
    title: `${cfg.institution} - CU Core Workstation`,
    frames: shellFrames(cfg, `${cfg.base}/members/search?memberId=${id}`),
    elements: [
      ...shellElements(cfg),
      ...searchFormElements(cfg.memberIdLabel),
      // search.ejs: <p><%= totalCount %> record(s) found</p> -- id kept from the earlier draft
      // (which modelled a "Results" heading that doesn't exist in the real view).
      el({ id: 'resultsHeading', role: 'generic', name: '1 record(s) found', text: '1 record(s) found', tag: 'p', frame: MAIN_FRAME, bbox: { x: 220, y: 250, w: 200, h: 24 } }),
      // search.ejs: <tr onclick="$$go('/members/<id>')" ...><td>id</td><td>name</td><td>joined</td><td>Active</td></tr>
      // -- a plain tr with no <a>/no ARIA role, matching docs/design/mock-app.md's "getByRole('link')
      // for results (row onclick, no anchor)".
      el({
        id: 'resultRow',
        role: 'clickable',
        name: member.resultText,
        text: member.resultText,
        tag: 'tr',
        css: [`tr[onclick*="/members/${id}"]`],
        frame: MAIN_FRAME,
        bbox: { x: 220, y: 280, w: 400, h: 24 },
      }),
    ],
  };
}

function buildMemberDetailScreen(cfg: TenantConfig, id: string, member: SeedMember): Omit<FakeScreenSpec, 'id'> {
  return {
    url: `${cfg.base}/workstation`,
    title: `${cfg.institution} - CU Core Workstation`,
    frames: shellFrames(cfg, `${cfg.base}/members/${id}?tab=profile`),
    elements: [
      ...shellElements(cfg),
      // detail.ejs: bare <span onclick="showTab(...)"> tabs, no ARIA role -- defeats
      // getByRole('tab') per docs/design/mock-app.md.
      el({ id: 'tabProfile', role: 'clickable', name: 'Profile', text: 'Profile', tag: 'span', frame: MAIN_FRAME, bbox: { x: 220, y: 130, w: 80, h: 24 } }),
      el({ id: 'tabAccounts', role: 'clickable', name: 'Accounts', text: 'Accounts', tag: 'span', frame: MAIN_FRAME, bbox: { x: 310, y: 130, w: 80, h: 24 } }),
      // detail.ejs profile table label/value cells, in real row order (Member Name, Member ID,
      // Join Date, Address, Phone, Savings Balance, Checking Balance); none of the labels carry
      // a trailing colon. Join Date/Address/Phone rows aren't modelled -- G1 never reads them.
      el({ id: 'memberNameLabel', role: 'cell', name: 'Member Name', text: 'Member Name', tag: 'td', row: 'r-name', frame: MAIN_FRAME, bbox: { x: 220, y: 170, w: 140, h: 24 } }),
      // Value cells: no `label` (a plain read-only <td> is not a form control, so production
      // never associates a label with it -- see packages/browser-agent/src/naming.ts's
      // `isFormControl` gate); `rowAnchorText`
      // gives the `relative` locator its anchor (the row's own label cell text) without implying a
      // (production-inaccurate) label association.
      el({
        id: 'memberName',
        role: 'cell',
        name: member.name,
        text: member.name,
        rowAnchorText: 'Member Name',
        tag: 'td',
        row: 'r-name',
        frame: MAIN_FRAME,
        bbox: { x: 370, y: 170, w: 200, h: 24 },
      }),
      el({ id: 'memberIdRowLabel', role: 'cell', name: 'Member ID', text: 'Member ID', tag: 'td', row: 'r-id', frame: MAIN_FRAME, bbox: { x: 220, y: 200, w: 140, h: 24 } }),
      el({
        id: 'memberIdValue',
        role: 'cell',
        name: id,
        text: id,
        rowAnchorText: 'Member ID',
        tag: 'td',
        row: 'r-id',
        frame: MAIN_FRAME,
        bbox: { x: 370, y: 200, w: 200, h: 24 },
      }),
      el({
        id: 'savingsBalanceLabel',
        role: 'cell',
        name: 'Savings Balance',
        text: 'Savings Balance',
        tag: 'td',
        row: 'r-sav',
        frame: MAIN_FRAME,
        bbox: { x: 220, y: 230, w: 140, h: 24 },
      }),
      el({
        id: 'savingsBalance',
        role: 'cell',
        name: member.savings,
        text: member.savings,
        rowAnchorText: 'Savings Balance',
        tag: 'td',
        row: 'r-sav',
        frame: MAIN_FRAME,
        bbox: { x: 370, y: 230, w: 200, h: 24 },
      }),
      el({
        id: 'checkingBalanceLabel',
        role: 'cell',
        name: 'Checking Balance',
        text: 'Checking Balance',
        tag: 'td',
        row: 'r-chk',
        frame: MAIN_FRAME,
        bbox: { x: 220, y: 260, w: 140, h: 24 },
      }),
      el({
        id: 'checkingBalance',
        role: 'cell',
        name: member.checking,
        text: member.checking,
        rowAnchorText: 'Checking Balance',
        tag: 'td',
        row: 'r-chk',
        frame: MAIN_FRAME,
        bbox: { x: 370, y: 260, w: 200, h: 24 },
      }),
    ].map((e) => (PROFILE_TABLE_IDS.has(e.id) ? { ...e, container: 'profile' } : e)),
  };
}

/** The profile table's cells: one record container for `readRecordText` (detail.ejs's table of label/value rows). */
const PROFILE_TABLE_IDS: ReadonlySet<string> = new Set([
  'memberNameLabel',
  'memberName',
  'memberIdRowLabel',
  'memberIdValue',
  'savingsBalanceLabel',
  'savingsBalance',
  'checkingBalanceLabel',
  'checkingBalance',
]);

function buildAccessDeniedScreen(cfg: TenantConfig): Omit<FakeScreenSpec, 'id'> {
  return {
    url: `${cfg.base}/workstation`,
    title: `${cfg.institution} - CU Core Workstation`,
    frames: shellFrames(cfg, `${cfg.base}/members/${RESTRICTED_MEMBER_ID}`),
    elements: [
      ...shellElements(cfg),
      // access-denied.ejs: <p class="denied">Access Denied: ...</p> -- a standalone 403 page (no
      // interstitial partial), loaded into the main frame by the result row's onclick navigation.
      el({
        id: 'deniedMsg',
        role: 'generic',
        name: 'Access Denied: your role does not permit viewing this member.',
        text: 'Access Denied: your role does not permit viewing this member.',
        tag: 'p',
        css: ['p.denied'],
        frame: MAIN_FRAME,
        bbox: { x: 220, y: 200, w: 400, h: 40 },
      }),
    ],
  };
}

function buildAppErrorScreen(cfg: TenantConfig): Omit<FakeScreenSpec, 'id'> {
  return {
    url: `${cfg.base}/workstation`,
    title: `${cfg.institution} - CU Core Workstation`,
    frames: shellFrames(cfg, `${cfg.base}/members/search`),
    elements: [
      ...shellElements(cfg),
      // search-error.ejs: standalone HTTP 500 page ("Application Error" / ORA-01017 stack
      // trace), loaded into the main frame while the failSearch fault is on.
      el({ id: 'appErrorTitle', role: 'heading', name: 'Application Error', text: 'Application Error', tag: 'h1', frame: MAIN_FRAME, bbox: { x: 220, y: 120, w: 300, h: 30 } }),
      el({
        id: 'appErrorDetail',
        role: 'generic',
        name: 'ORA-01017: invalid username/password; logon denied',
        text: 'ORA-01017: invalid username/password; logon denied',
        tag: 'b',
        frame: MAIN_FRAME,
        bbox: { x: 220, y: 160, w: 500, h: 24 },
      }),
    ],
  };
}

function buildSessionExpiredScreen(cfg: TenantConfig): Omit<FakeScreenSpec, 'id'> {
  return {
    url: `${cfg.base}/session-expired`,
    title: 'Session Expired',
    text: ['Your session has expired. Click here to log in.'],
    elements: [el({ id: 'relogin', role: 'link', name: 'Click here', text: 'Click here', tag: 'a', bbox: { x: 220, y: 200, w: 100, h: 20 } })],
  };
}

/** Which screen a search for `memberId` lands on: `app_error` when the failSearch fault is on
 * (regardless of what was typed, mirroring GET /members/search always returning 500), else
 * `search_empty` for anything not in the seed. */
function makeSearchDestination(failSearch: boolean): (ctx: TransitionContext) => TransitionTarget {
  return (ctx: TransitionContext): TransitionTarget => {
    if (failSearch) return 'app_error';
    const id = (ctx.values.memberId ?? '').trim();
    return SEED_IDS.has(id) ? `search_results_${id}` : 'search_empty';
  };
}

/**
 * Builds the `FakeScenario` graph for the CU Core Workstation mock app: login through member
 * search, member detail, and the access-denied/error/session-expiry paths.
 */
export function createCuCoreScenario(opts: CreateCuCoreScenarioOptions = {}): FakeScenario {
  const tenant = opts.tenant ?? 'a';
  const interstitial = opts.interstitial ?? true;
  const cfg = TENANT_CONFIG[tenant];
  const searchDestination = makeSearchDestination(opts.failSearch ?? false);

  const screens = new Map<string, FakeScreenSpec>();
  const add = (id: string, spec: Omit<FakeScreenSpec, 'id'>): void => {
    screens.set(id, { id, ...spec });
  };

  add('login', buildLoginScreen(cfg));
  add('login_error', buildLoginScreen(cfg, 'Invalid user ID or password.'));
  add('workstation', buildWorkstationScreen(cfg));
  add('workstation_notice', buildWorkstationNoticeScreen(cfg));
  add('search_empty', buildSearchEmptyScreen(cfg));
  add('access_denied', buildAccessDeniedScreen(cfg));
  add('app_error', buildAppErrorScreen(cfg));
  add('session_expired', buildSessionExpiredScreen(cfg));
  for (const [id, member] of Object.entries(SEED_MEMBERS)) {
    add(`search_results_${id}`, buildSearchResultsScreen(cfg, id, member));
    if (id !== RESTRICTED_MEMBER_ID) add(`member_${id}`, buildMemberDetailScreen(cfg, id, member));
  }

  const rules: TransitionRule[] = [
    { from: '*', match: { actionType: 'navigate', url: `${cfg.base}/login` }, to: 'login' },
    { from: '*', match: { actionType: 'navigate', url: `${cfg.base}/workstation` }, to: 'workstation' },
    { from: '*', match: { actionType: 'navigate', url: `${cfg.base}/session-expired` }, to: 'session_expired' },

    // Sign on: correct credentials -> workstation (with or without the interstitial);
    // anything else -> login_error. The unguarded rule is the "otherwise" fallback -- it is
    // only reached when the guarded rule above it didn't match, since findRule takes the
    // first matching rule in declaration order.
    {
      from: 'login',
      match: { actionType: 'click', targetId: 'signOn' },
      when: (ctx) => ctx.values.userId === 'operator1' && ctx.values.password === 'demo-pass-123',
      to: interstitial ? 'workstation_notice' : 'workstation',
    },
    { from: 'login', match: { actionType: 'click', targetId: 'signOn' }, to: 'login_error' },
    {
      from: 'login_error',
      match: { actionType: 'click', targetId: 'signOn' },
      when: (ctx) => ctx.values.userId === 'operator1' && ctx.values.password === 'demo-pass-123',
      to: interstitial ? 'workstation_notice' : 'workstation',
    },
    { from: 'login_error', match: { actionType: 'click', targetId: 'signOn' }, to: 'login_error' },

    // Maintenance interstitial.
    { from: 'workstation_notice', match: { actionType: 'click', targetId: 'maintOk' }, to: 'workstation' },

    // Nav: "Member Search" re-shows the (already-visible) search form; from workstation /
    // workstation_notice this is a same-screen no-navigation click, from anywhere else it
    // resets back to a fresh 'workstation'. "Log Off" always returns to the login screen.
    { from: 'workstation', match: { actionType: 'click', targetId: 'navMemberSearch' }, to: 'workstation' },
    { from: 'workstation_notice', match: { actionType: 'click', targetId: 'navMemberSearch' }, to: 'workstation_notice' },
    { from: '*', match: { actionType: 'click', targetId: 'navMemberSearch' }, to: 'workstation' },
    { from: '*', match: { actionType: 'click', targetId: 'navSignOff' }, to: 'login' },

    // Member search: click Search, or press Enter after typing a member id.
    { from: 'workstation', match: { actionType: 'click', targetId: 'search' }, to: searchDestination },
    { from: 'workstation', match: { actionType: 'press', key: 'Enter' }, to: searchDestination },
  ];
  for (const id of Object.keys(SEED_MEMBERS)) {
    rules.push({
      from: `search_results_${id}`,
      match: { actionType: 'click', targetId: 'resultRow' },
      to: id === RESTRICTED_MEMBER_ID ? 'access_denied' : `member_${id}`,
    });
  }

  return {
    initial: 'login',
    viewport: DEFAULT_CU_CORE_VIEWPORT,
    latencyMs: opts.latencyMs,
    sessionExpiredScreen: 'session_expired',
    screens: Object.fromEntries(screens),
    rules,
  };
}

const DEFAULT_CU_CORE_VIEWPORT = { width: 1280, height: 800 };

/** Convenience wrapper: builds the CU Core scenario and wraps it in a `FakeSurface`. */
export function createCuCoreSurface(opts: (CreateCuCoreScenarioOptions & Pick<FakeSurfaceOptions, 'clock'>) | undefined = {}): FakeSurface {
  const scenario = createCuCoreScenario(opts);
  return new FakeSurface(scenario, { clock: opts.clock });
}
