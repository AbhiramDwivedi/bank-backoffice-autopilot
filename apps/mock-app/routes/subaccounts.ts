/**
 * Sub-account opening flow.
 *   GET  /members/:id/subaccounts/new                  -> form
 *   POST /members/:id/subaccounts                       -> validate + create
 *   GET  /members/:id/subaccounts/:ref/confirmation      -> confirmation
 */
import type { Express } from 'express';
import { resolveMember, takeInterstitial } from '../context.js';
import { ACCOUNT_TYPES, nextReference } from '../data/seed.js';
import type { SubAccount } from '../data/seed.js';
import type { AppContext } from '../context.js';

interface FormValues {
  accountType: string;
  nickname: string;
  initialDeposit: string;
  branchCode: string;
}

const EMPTY_VALUES: FormValues = { accountType: '', nickname: '', initialDeposit: '', branchCode: '' };

/** "MM/DD/YYYY" for today, matching the seed data's date format. */
function formatToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${String(d.getFullYear())}`;
}

/** Registers the sub-account opening routes: new-account form, validation and creation, and confirmation page. */
export function registerSubaccountRoutes(app: Express, ctx: AppContext): void {
  app.get('/members/:id/subaccounts/new', (req, res) => {
    const m = resolveMember(ctx, req, res, req.params.id);
    if (!m) return;

    res.render('subaccount-form', {
      member: m,
      accountTypes: ACCOUNT_TYPES,
      values: EMPTY_VALUES,
      errors: [] as string[],
      interstitial: takeInterstitial(ctx, req),
    });
  });

  app.post('/members/:id/subaccounts', (req, res) => {
    const m = resolveMember(ctx, req, res, req.params.id);
    if (!m) return;

    const body = req.body as Record<string, unknown>;
    const rawAccountType = typeof body.accountType === 'string' ? body.accountType : '';
    const rawNickname = typeof body.nickname === 'string' ? body.nickname : '';
    const rawInitialDeposit = typeof body.initialDeposit === 'string' ? body.initialDeposit : '';
    const rawBranchCode = typeof body.branchCode === 'string' ? body.branchCode : '';

    const errors: string[] = [];

    const accountTypeEntry = ACCOUNT_TYPES.find((t) => t.code === rawAccountType);
    if (!rawAccountType || !accountTypeEntry) {
      errors.push('Please select an account type.');
    }

    const normalizedDeposit = rawInitialDeposit.replace(/^\$/, '').replace(/,/g, '').replace(/\s/g, '');
    let depositAmount = 0;
    if (!normalizedDeposit || !/^\d+(\.\d{1,2})?$/.test(normalizedDeposit)) {
      errors.push('Initial deposit must be a number.');
    } else {
      depositAmount = Number(normalizedDeposit);
      if (depositAmount < 25) {
        errors.push('Initial deposit must be at least $25.00');
      }
    }

    if (rawNickname.length > 30) {
      errors.push('Nickname must be 30 characters or fewer.');
    }

    if (ctx.tenant.requireBranchCode) {
      const trimmedBranch = rawBranchCode.trim();
      if (!trimmedBranch) {
        errors.push('Branch code is required.');
      } else if (!/^\d{3}$/.test(trimmedBranch)) {
        errors.push('Branch code must be 3 digits.');
      }
    }

    if (errors.length > 0) {
      res.status(200).render('subaccount-form', {
        member: m,
        accountTypes: ACCOUNT_TYPES,
        values: {
          accountType: rawAccountType,
          nickname: rawNickname,
          initialDeposit: rawInitialDeposit,
          branchCode: rawBranchCode,
        },
        errors,
        interstitial: takeInterstitial(ctx, req),
      });
      return;
    }

    // No errors: accountTypeEntry is guaranteed defined here.
    const type = accountTypeEntry as { code: string; label: string };
    const ref = nextReference(ctx.state);
    const existingS = m.accounts.filter((a) => a.suffix.startsWith('S')).length;
    const suffix = `S${String(existingS + 1).padStart(2, '0')}`;
    const nickname = rawNickname.trim() || type.label;

    const account: SubAccount = {
      suffix,
      type: type.label,
      nickname,
      balanceCents: Math.round(depositAmount * 100),
      opened: formatToday(),
      reference: ref,
    };
    if (ctx.tenant.requireBranchCode) {
      account.branchCode = rawBranchCode.trim();
    }
    m.accounts.push(account);

    res.redirect(302, `/members/${m.id}/subaccounts/${ref}/confirmation`);
  });

  app.get('/members/:id/subaccounts/:ref/confirmation', (req, res) => {
    const m = resolveMember(ctx, req, res, req.params.id);
    if (!m) return;

    const account = m.accounts.find((a) => a.reference === req.params.ref);
    if (!account) {
      res
        .status(404)
        .type('html')
        .send(
          '<html><head><script type="text/javascript" src="/static/cu-agent.js"></script>' +
            '<title>Not Found</title></head><body><p>Reference not found.</p></body></html>',
        );
      return;
    }

    res.render('subaccount-confirmation', {
      member: m,
      account,
      interstitial: takeInterstitial(ctx, req),
    });
  });
}
