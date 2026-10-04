/** Identifies which configured institution a mock-app instance represents. */
export type TenantId = 'a' | 'b';

/** Same vendor product ("CU Core Workstation" by Acme Core Systems), configured per institution. */
export interface TenantConfig {
  id: TenantId;
  institution: string;
  shortName: string;
  /** Banner colours. */
  bannerBg: string;
  bannerFg: string;
  accent: string;
  /** Label for the member id search field. */
  memberIdLabel: 'Member ID' | 'Member #';
  /** Tenant A: real <frameset>. Tenant B: <iframe name="main"> inside a table layout. */
  shell: 'frameset' | 'iframe';
  /** Tenant B requires a branch code when opening a sub-account. */
  requireBranchCode: boolean;
  defaultPort: number;
}

export const TENANTS: Record<TenantId, TenantConfig> = {
  a: {
    id: 'a',
    institution: 'Pioneer Valley Community CU',
    shortName: 'PVCCU',
    bannerBg: '#003366',
    bannerFg: '#FFCC00',
    accent: '#336699',
    memberIdLabel: 'Member ID',
    shell: 'frameset',
    requireBranchCode: false,
    defaultPort: 4173,
  },
  b: {
    id: 'b',
    institution: 'Riverbend Federal Credit Union',
    shortName: 'RFCU',
    bannerBg: '#5A1E1E',
    bannerFg: '#F2E6C9',
    accent: '#8C3B2E',
    memberIdLabel: 'Member #',
    shell: 'iframe',
    requireBranchCode: true,
    defaultPort: 4174,
  },
};

export const VENDOR = 'Acme Core Systems';
export const PRODUCT = 'CU Core Workstation';
export const PRODUCT_VERSION = '7.4.2 (build 2012.11)';
