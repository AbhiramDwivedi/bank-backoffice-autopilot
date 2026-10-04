/**
 * A small branch ledger, served on an ephemeral port, for testing what replay does when a page
 * that showed ONE record at record time shows SEVERAL at replay. The markup and wording are this
 * repo's own; the app is called "Branch Ledger".
 *
 * A member's pages list one card per account holder. Most members hold their account alone. A
 * joint account lists the other holder too, in the same markup, before or after the member's own
 * card (`listedFirst` / `listedAfter`). So on a joint member's page every label ("Savings Balance")
 * and every per-card control ("View statement") appears twice, and whatever sat at a recorded
 * position may now be the other holder's.
 *
 * Two ways in, from the home page:
 *  - "Open" (GET /open?member=<id>, redirects to /members/<id>): the record's own page, with the
 *    member number in the URL path. Cards show each holder's name and savings balance in a
 *    two-column label/value table.
 *  - "Find" (POST /find): the same holders at a URL that does not show the member number, each
 *    card with a "View statement" button. The cards do not show the member number either, so
 *    nothing on the page ties a card to the number searched for.
 *
 * Each card on a record's own page also shows its holder's member number ("Member Number"), so
 * the page says whose card it is. The statement search's cards do not (see above).
 *
 * GET /people is a name search with a detail panel, the third way in: GET /people?q=<text> lists
 * every person whose name contains the text (case-insensitive) and opens the detail panel of the
 * LAST one listed, showing that person's name and balance. "Smithers" lists one person, Al
 * Smithers; "Smith" lists Jane Smith and Al Smithers with Al's panel open. The panel's "Balance"
 * label appears once, whoever is listed.
 *
 * GET /statements/<token> shows one holder's statement (name and closing balance); the token is
 * opaque and holds no member number. The server records every statement opened
 * (`statementViews`, by member id), so a test can tell whose statement a replay opened.
 *
 * `savingsLabel` renames one member's "Savings Balance" row label, for the case where a label is
 * simply gone rather than repeated. The page then says so in a note under the cards ("Savings
 * Balance is listed as Share Balance for this account type."), so the words are still on the
 * page, as they are when a product renames a field, but no longer beside the value.
 *
 * A member with `savings: null` has no savings row at all. On such a member's joint page the only
 * "Savings Balance" label is the other holder's.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One member of the ledger. */
export interface LedgerMember {
  id: string;
  name: string;
  /** The savings balance as displayed; null = no savings account, so no savings row on the card. */
  savings: string | null;
  /** Closing balance on the member's statement. */
  closing: string;
  /** Opaque statement token: letters only, never the member number. */
  token: string;
  /** Ids of other holders listed on this member's pages BEFORE the member's own card. */
  listedFirst?: readonly string[];
  /** Ids of other holders listed AFTER the member's own card. */
  listedAfter?: readonly string[];
  /** The label of the savings row on this member's own card (default "Savings Balance"). */
  savingsLabel?: string;
}

/** A person on the name search (`/people`). */
export interface LedgerPerson {
  name: string;
  balance: string;
}

/** The people the name search lists, in display order. */
export const LEDGER_PEOPLE: readonly LedgerPerson[] = [
  { name: 'Jane Smith', balance: '$500.00' },
  { name: 'Al Smithers', balance: '$75.25' },
];

/** The app's name, shown in the header of every page. */
export const LEDGER_NAME = 'Branch Ledger';

/**
 * The standard members. 1001 holds an account alone. 2002 and 5005 hold joint accounts: 2002's
 * pages list the other holder (3003) first, 5005's list the other holder (3003) after. 4004's
 * savings row carries another label. 6006 has no savings account and a joint holder (3003) who
 * has one.
 */
export const LEDGER_MEMBERS: readonly LedgerMember[] = [
  { id: '1001', name: 'Jane Doe', savings: '$1,234.56', closing: '$1,200.00', token: 'qzjane' },
  { id: '2002', name: 'Bob Stone', savings: '$20.00', closing: '$18.50', token: 'qzbob', listedFirst: ['3003'] },
  { id: '3003', name: 'Ann Reyes', savings: '$9,999.99', closing: '$9,750.25', token: 'qzann' },
  { id: '4004', name: 'Cy Marsh', savings: '$410.10', closing: '$400.00', token: 'qzcy', savingsLabel: 'Share Balance' },
  { id: '5005', name: 'Di Okoro', savings: '$77.00', closing: '$70.00', token: 'qzdi', listedAfter: ['3003'] },
  { id: '6006', name: 'Eli Varga', savings: null, closing: '$0.00', token: 'qzeli', listedAfter: ['3003'] },
];

/** A running ledger. */
export interface Ledger {
  /** http://localhost:<port> */
  baseUrl: string;
  /** Every request (method + path), in order. */
  requests: { method: string; path: string }[];
  /** Member ids whose statement was opened, in order. */
  statementViews: string[];
  close(): Promise<void>;
}

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #1d2433; background: #fff; }
.topbar { padding: 12px 24px; border-bottom: 1px solid #ddd; font-size: 22px; font-weight: bold; }
.page-heading { padding: 12px 24px; font-size: 18px; font-weight: 600; }
.lookup { display: flex; gap: 8px; padding: 8px 24px; }
.lookup input { width: 220px; padding: 6px; }
.holders { display: flex; flex-direction: column; gap: 16px; padding: 8px 24px; width: 520px; }
.holder { border: 1px solid #ddd; border-radius: 6px; padding: 12px; }
.holder-name { font-size: 17px; font-weight: 600; margin-bottom: 8px; }
.note { padding: 8px 24px; font-size: 13px; color: #555; }
table.acct td { padding: 4px 12px 4px 0; }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${LEDGER_NAME}</title><style>${CSS}</style></head><body><div class="topbar">${LEDGER_NAME}</div>${body}</body></html>`;
}

function homePage(): string {
  return page(`<div class="page-heading">Member lookup</div>
<form class="lookup" method="get" action="/open"><input type="text" name="member" placeholder="Member number" autocomplete="off"><button type="submit">Open</button></form>
<form class="lookup" method="post" action="/find"><input type="text" name="member" placeholder="Statement search" autocomplete="off"><button type="submit">Find</button></form>`);
}

/** The holders a member's pages list, in display order. */
function holdersOf(member: LedgerMember, all: readonly LedgerMember[]): { holder: LedgerMember; own: boolean }[] {
  const others = (ids: readonly string[] | undefined): { holder: LedgerMember; own: boolean }[] =>
    (ids ?? []).flatMap((id) => {
      const holder = all.find((m) => m.id === id);
      return holder ? [{ holder, own: false }] : [];
    });
  return [...others(member.listedFirst), { holder: member, own: true }, ...others(member.listedAfter)];
}

/** The record's own page: one label/value table per holder. */
function memberPage(member: LedgerMember, all: readonly LedgerMember[]): string {
  const cards = holdersOf(member, all)
    .map(
      ({ holder, own }) => `<div class="holder"><table class="acct">
  <tr><td>Member Name</td><td>${escapeHtml(holder.name)}</td></tr>
  <tr><td>Member Number</td><td>${escapeHtml(holder.id)}</td></tr>${
    holder.savings === null
      ? ''
      : `\n  <tr><td>${escapeHtml(own ? (member.savingsLabel ?? 'Savings Balance') : 'Savings Balance')}</td><td>${escapeHtml(holder.savings)}</td></tr>`
  }
</table></div>`,
    )
    .join('\n');
  const note =
    member.savingsLabel !== undefined
      ? `\n<div class="note">Savings Balance is listed as ${escapeHtml(member.savingsLabel)} for this account type.</div>`
      : '';
  return page(`<div class="page-heading">Member record</div>\n<div class="holders">${cards}</div>${note}`);
}

/** The statement search's result: one card per holder, with no member number on it. */
function findPage(member: LedgerMember | undefined, all: readonly LedgerMember[]): string {
  if (!member) return page('<div class="page-heading">Statements</div>\n<div class="none-found">No statements found.</div>');
  const cards = holdersOf(member, all)
    .map(
      ({ holder }) => `<div class="holder"><div class="holder-name">${escapeHtml(holder.name)}</div>
  <button type="button" onclick="location.href='/statements/${holder.token}'">View statement</button></div>`,
    )
    .join('\n');
  return page(`<div class="page-heading">Statements</div>\n<div class="holders">${cards}</div>`);
}

/** The name search: a result list, and the detail panel of the last person listed. */
function peoplePage(q: string, people: readonly LedgerPerson[]): string {
  const form = `<div class="page-heading">People</div>
<form class="lookup" method="get" action="/people"><input type="text" name="q" placeholder="Name" value="${escapeHtml(q)}" autocomplete="off"><button type="submit">Look up</button></form>`;
  if (q === '') return page(form);
  const found = people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  if (found.length === 0) return page(`${form}
<div class="none-found">No people found.</div>`);
  const list = found.map((p) => `<li>${escapeHtml(p.name)}</li>`).join('');
  const open = found[found.length - 1]!;
  return page(`${form}
<ul class="results">${list}</ul>
<div class="holders"><div class="holder"><div class="holder-name">Detail</div><table class="acct">
  <tr><td>Name</td><td>${escapeHtml(open.name)}</td></tr>
  <tr><td>Balance</td><td>${escapeHtml(open.balance)}</td></tr>
</table></div></div>`);
}

function statementPage(holder: LedgerMember): string {
  return page(`<div class="page-heading">Statement</div>
<div class="holders"><div class="holder"><table class="acct">
  <tr><td>Account holder</td><td>${escapeHtml(holder.name)}</td></tr>
  <tr><td>Closing balance</td><td>${escapeHtml(holder.closing)}</td></tr>
</table></div></div>`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > 10_000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
}

/** Starts a ledger on an ephemeral port (dual-stack, so "localhost" works either way). */
export async function startLedger(members: readonly LedgerMember[] = LEDGER_MEMBERS): Promise<Ledger> {
  const requests: { method: string; path: string }[] = [];
  const statementViews: string[] = [];
  const byId = (id: string | null): LedgerMember | undefined => members.find((m) => m.id === id);
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    void (async () => {
      if (method === 'GET' && url.pathname === '/') return send(res, 200, homePage());
      if (method === 'GET' && url.pathname === '/open') {
        const member = byId(url.searchParams.get('member'));
        if (!member) return send(res, 404, page('<div class="page-heading">No such member</div>'));
        return res.writeHead(302, { location: `/members/${member.id}` }).end();
      }
      const own = /^\/members\/([^/]+)$/.exec(url.pathname);
      if (method === 'GET' && own) {
        const member = byId(decodeURIComponent(own[1]!));
        return member ? send(res, 200, memberPage(member, members)) : send(res, 404, page('<div class="page-heading">No such member</div>'));
      }
      if (method === 'GET' && url.pathname === '/people') return send(res, 200, peoplePage((url.searchParams.get('q') ?? '').trim(), LEDGER_PEOPLE));
      if (method === 'POST' && url.pathname === '/find') {
        return send(res, 200, findPage(byId(new URLSearchParams(await readBody(req)).get('member')), members));
      }
      const statement = /^\/statements\/([a-z]+)$/.exec(url.pathname);
      if (method === 'GET' && statement) {
        const holder = members.find((m) => m.token === statement[1]);
        if (!holder) return send(res, 404, page('<div class="page-heading">No such statement</div>'));
        statementViews.push(holder.id);
        return send(res, 200, statementPage(holder));
      }
      return send(res, 404, page('<div class="page-heading">Not found</div>'));
    })().catch(() => {
      if (!res.headersSent) send(res, 500, page('<div class="page-heading">Error</div>'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    statementViews,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
