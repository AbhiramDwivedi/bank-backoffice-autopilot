/**
 * Seed data for CU Core Workstation. All names, addresses and numbers are fictional.
 * Balances are stored in integer cents to avoid float drift.
 */

/** A single sub-account (savings, checking, etc.) attached to a member. */
export interface SubAccount {
  /** Display suffix, e.g. "S01", "D01", "S02". */
  suffix: string;
  type: string;
  nickname: string;
  balanceCents: number;
  opened: string; // MM/DD/YYYY
  /** Reference number when opened through the workstation, e.g. "SA-1000001". */
  reference?: string;
  branchCode?: string;
}

/** A credit-union member and their accounts. */
export interface Member {
  id: string;
  firstName: string;
  middleInitial?: string;
  lastName: string;
  joinDate: string; // MM/DD/YYYY
  savingsCents: number;
  checkingCents: number;
  restricted: boolean;
  address: string;
  phone: string; // fake 555 numbers only
  accounts: SubAccount[];
}

/** In-memory data for one mock-app instance: all members and the sub-account reference counter. */
export interface AppState {
  members: Map<string, Member>;
  /** Next sub-account reference counter; formatted as "SA-" + 7 digits. */
  nextRef: number;
}

/** Values of the custom Account Type dropdown (the hidden input carries the code). */
export const ACCOUNT_TYPES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'SAV', label: 'Share Savings' },
  { code: 'MMA', label: 'Money Market' },
  { code: 'CD', label: 'Share Certificate' },
  { code: 'XMAS', label: 'Christmas Club' },
  { code: 'CHK', label: 'Share Draft (Checking)' },
];

type Row = [id: string, first: string, mi: string, last: string, joined: string, savings: number, checking: number];

const RAW: Row[] = [
  ['10001', 'Harold', 'T', 'Abernathy', '03/14/1994', 482_210, 91_544],
  ['10002', 'Denise', 'M', 'Kowalczyk', '07/02/2001', 1_250_000, 43_018],
  ['10003', 'Marcus', 'L', 'Oyelaran', '11/19/2008', 7_533, 2_210],
  ['10004', 'Patricia', 'A', 'Brennan', '01/30/1989', 3_418_902, 511_390],
  ['10005', 'Thomas', 'J', 'Brennan', '01/30/1989', 22_150, 188_004],
  ['10006', 'Lucinda', 'R', 'Vasquez-Hale', '05/05/2012', 64_000, 12_375],
  ['10007', 'Gerald', '', 'Pfeiffer', '09/23/1997', 915_560, 74_411],
  ['10008', 'Aisha', 'K', 'Montgomery', '02/11/2015', 2_500, 36_720],
  ['10009', 'Wendell', 'P', 'Sampson', '06/17/2003', 150_025, 9_933],
  ['10010', 'Rosalind', 'E', 'Sampson', '06/17/2003', 88_812, 120_450],
  ['10011', 'Victor', 'H', 'Nakamura', '12/01/2009', 5_012_330, 890_100],
  ['10012', 'Bernadette', 'C', 'Quill', '04/28/1999', 33_333, 4_455],
  ['10013', 'Clifford', 'D', 'Ashworth', '08/08/2018', 1_000, 600],
  ['10014', 'Imogen', 'S', 'Farraday', '10/10/2006', 271_828, 31_415],
  ['10015', 'Rudolph', 'B', 'Delacroix', '03/03/1993', 619_004, 57_210],
  ['10016', 'Ophelia', 'N', 'Grantham', '07/21/2011', 12_900, 88_000],
  ['10017', 'Desmond', 'W', 'Achterberg', '01/09/2020', 45_600, 7_890],
  ['10018', 'Mavis', 'G', 'Thistlewood', '11/30/1985', 2_222_222, 150_000],
  ['10019', 'Leopold', 'F', 'Sanderling', '02/14/2014', 70_115, 22_987],
  ['10020', 'Priscilla', 'O', 'Samuels', '06/06/2016', 5_550, 13_120],
];

const STREETS = ['Elm', 'Mill', 'Orchard', 'Canal', 'Depot'];

function makeMember(row: Row, restricted = false): Member {
  const [id, firstName, mi, lastName, joinDate, savingsCents, checkingCents] = row;
  const n = Number(id) % 97;
  return {
    id,
    firstName,
    middleInitial: mi || undefined,
    lastName,
    joinDate,
    savingsCents,
    checkingCents,
    restricted,
    address: `${100 + n * 7} ${STREETS[n % 5]} St, Springfield, MA 01103`,
    phone: `(413) 555-01${String(n % 100).padStart(2, '0')}`,
    accounts: [
      { suffix: 'S01', type: 'Share Savings', nickname: 'Primary Share', balanceCents: savingsCents, opened: joinDate },
      { suffix: 'D01', type: 'Share Draft (Checking)', nickname: 'Checking', balanceCents: checkingCents, opened: joinDate },
    ],
  };
}

/** Build a fresh copy of the seed. Called per createApp() and by POST /__reset. */
export function createSeedState(): AppState {
  const members = new Map<string, Member>();
  for (const r of RAW) members.set(r[0], makeMember(r));
  members.set('12345', makeMember(['12345', 'Jane', 'Q', 'Sample', '08/15/2004', 123_456, 31_000]));
  members.set('90001', makeMember(['90001', 'Restricted', 'X', 'Insider', '01/01/2000', 999_999, 99_999], true));
  // 99999 is intentionally absent (not found).
  return { members, nextRef: 1000001 };
}

/** 123456 -> "$1,234.56" */
export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** "Jane Q. Sample" */
export function fullName(m: Member): string {
  return [m.firstName, m.middleInitial ? `${m.middleInitial}.` : '', m.lastName].filter(Boolean).join(' ');
}

/** Exact member id match (wins if given), else case-insensitive last-name prefix. Sorted by last name, then id. */
export function searchMembers(state: AppState, q: { memberId?: string; lastName?: string }): Member[] {
  const id = (q.memberId ?? '').trim();
  const ln = (q.lastName ?? '').trim().toLowerCase();
  if (id) {
    const m = state.members.get(id);
    return m ? [m] : [];
  }
  if (!ln) return [];
  return [...state.members.values()]
    .filter((m) => m.lastName.toLowerCase().startsWith(ln))
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.id.localeCompare(b.id));
}

/** Allocate the next reference: "SA-1000001", "SA-1000002", ... */
export function nextReference(state: AppState): string {
  const ref = `SA-${String(state.nextRef).padStart(7, '0')}`;
  state.nextRef += 1;
  return ref;
}
