import type { Express } from 'express';
import { searchMembers } from '../data/seed.js';
import { chaosRuntime, drawSite, resolveMember, takeInterstitial } from '../context.js';
import { drawFault } from '../chaos.js';
import type { AppContext } from '../context.js';

const PAGE_SIZE = 10;

/** Pull a plain string query param, ignoring arrays/nested qs objects. */
function qstr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Registers /members/search (paginated search) and /members/:id (detail, with tab and expiry-warning query params). */
export function registerMemberRoutes(app: Express, ctx: AppContext): void {
  app.get('/members/search', (req, res) => {
    // The switch wins; chaos draws only when it is off.
    if (ctx.faults.failSearch || drawFault(chaosRuntime(ctx), 'failSearch', drawSite(req))) {
      // Do NOT consume the interstitial here: the error page is not a successful
      // main-content render.
      res.status(500).render('search-error');
      return;
    }

    const memberIdRaw = req.query.memberId;
    const lastNameRaw = req.query.lastName;
    // A search was "submitted" if either param is present at all, even as ''.
    const searched = memberIdRaw !== undefined || lastNameRaw !== undefined;
    const memberId = qstr(memberIdRaw) ?? '';
    const lastName = qstr(lastNameRaw) ?? '';

    let page = 1;
    const pageRaw = qstr(req.query.page);
    if (pageRaw !== undefined) {
      const n = Number.parseInt(pageRaw, 10);
      if (Number.isFinite(n) && n >= 1) page = n;
    }

    const invalidMemberId = memberId.trim() !== '' && !/^\d+$/.test(memberId.trim());

    const allResults = searched ? searchMembers(ctx.state, { memberId, lastName }) : [];
    const totalCount = allResults.length;
    const start = (page - 1) * PAGE_SIZE;
    const results = allResults.slice(start, start + PAGE_SIZE);
    const hasNext = start + PAGE_SIZE < totalCount;
    const hasPrev = page > 1;

    res.render('search', {
      memberId,
      lastName,
      searched,
      results,
      totalCount,
      page,
      hasNext,
      hasPrev,
      invalidMemberId,
      interstitial: takeInterstitial(ctx, req),
    });
  });

  app.get('/members/:id', (req, res) => {
    const m = resolveMember(ctx, req, res, req.params.id);
    if (!m) return;

    const tabRaw = qstr(req.query.tab);
    const tab: 'profile' | 'accounts' | 'notes' =
      tabRaw === 'accounts' || tabRaw === 'notes' ? tabRaw : 'profile';
    const warn = qstr(req.query.warn) === '1';

    res.render('detail', {
      member: m,
      tab,
      warn,
      interstitial: takeInterstitial(ctx, req),
    });
  });
}
