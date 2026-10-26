export type TourTarget =
  | 'dashboard-header'
  | 'dashboard-value-chart'
  | 'tour-nav'
  | 'assets-stats'
  | 'agent-roster'
  | 'governance-list'
  | 'policy-rules'
  | 'bridge-form'
  | 'stake-form'
  | 'settings-profile'
  | 'tour-product'
  | 'pay-metrics'
  | 'tour-topbar';

export type WalkthroughProduct = 'nave' | 'pay';

export type WalkthroughPageId =
  | 'overview'
  | 'money'
  | 'agents'
  | 'decisions'
  | 'rules'
  | 'bridge'
  | 'stake'
  | 'settings'
  | 'pay';

export type WalkthroughStep = {
  id: string;
  target: TourTarget;
  /** Extra regions joined into one opening. The first step uses this so the window covers the dashboard and the header menu together. */
  parts?: readonly string[];
  /** Allow a taller opening than the usual section frame. */
  roomy?: boolean;
  navPath: string;
  product: WalkthroughProduct;
  page: WalkthroughPageId;
  title: string;
  sentence: string;
};

export const WALKTHROUGH_STEPS: readonly WalkthroughStep[] = [
  {
    id: 'dashboard',
    target: 'dashboard-header',
    parts: ['dashboard-header', 'dashboard-value-chart', 'dashboard-metrics', 'tour-topbar'],
    roomy: true,
    navPath: '/overview',
    product: 'nave',
    page: 'overview',
    title: 'Overview',
    sentence: 'You first arrive to your dashboard where we display immediately pertinent information about your treasury balance and overall health. The menu in the corner lets you switch networks and wallets as needed.',
  },
  {
    id: 'navigation',
    target: 'tour-nav',
    navPath: '/overview',
    product: 'nave',
    page: 'overview',
    title: 'Navigation',
    sentence: 'This menu is how you move through the treasury. Overview is the dashboard you just saw. Money, Agents, Decisions, Rules, Bridge, Stake, and Settings are the other sections you use to run it.',
  },
  {
    id: 'money',
    target: 'assets-stats',
    navPath: '/money',
    product: 'nave',
    page: 'money',
    title: 'Money',
    sentence: 'This is how the treasury’s money is split right now. Safe and available is cash that is not deployed. Earning is capital already in approved places. Free to spend is the amount that can be paid out under the current rules.',
  },
  {
    id: 'agents',
    target: 'agent-roster',
    navPath: '/agents',
    product: 'nave',
    page: 'agents',
    title: 'Agents',
    sentence: 'These are the four agents that operate the treasury. The Coordinator, the Investor, and the Guardrail each have to sign before a transaction is sent. The Watcher stays on the treasury and can freeze activity if something is wrong.',
  },
  {
    id: 'decisions',
    target: 'governance-list',
    navPath: '/decisions',
    product: 'nave',
    page: 'decisions',
    title: 'Decisions',
    sentence: 'This is the list of proposals for the treasury. Members vote here. When a proposal passes, the agents carry it out, and the result stays on this list so you can see what was decided.',
  },
  {
    id: 'rules',
    target: 'policy-rules',
    navPath: '/rules',
    product: 'nave',
    page: 'rules',
    title: 'Rules',
    sentence: 'This is the constitution the agents have to follow. It sets approved assets, reserve limits, and what they are allowed to do. A change is proposed and voted on before it takes effect.',
  },
  {
    id: 'bridge',
    target: 'bridge-form',
    navPath: '/bridge',
    product: 'nave',
    page: 'bridge',
    title: 'Bridge',
    sentence: 'Use this form when you need to bring assets in from another network. You set where the funds are coming from and how much to move, and the quote updates as you change the amount.',
  },
  {
    id: 'stake',
    target: 'stake-form',
    navPath: '/stake',
    product: 'nave',
    page: 'stake',
    title: 'Stake',
    sentence: 'This is where you stake NAVE to earn protocol rewards. You can unstake or claim those rewards from this same form when you are ready.',
  },
  {
    id: 'settings',
    target: 'settings-profile',
    navPath: '/settings',
    product: 'nave',
    page: 'settings',
    title: 'Settings',
    sentence: 'This is the treasury’s profile: its name, public link, and description. Further down the page you manage members, guardians, notifications, and the emergency controls.',
  },
  {
    id: 'product',
    target: 'tour-product',
    navPath: '/settings',
    product: 'nave',
    page: 'settings',
    title: 'Products',
    sentence: 'The Nave logo opens this menu. Nave is the treasury you have been looking at. Nave Pay is the separate set of books for invoices and bills on that same treasury.',
  },
  {
    id: 'pay-home',
    target: 'pay-metrics',
    navPath: '/pay',
    product: 'pay',
    page: 'pay',
    title: 'Nave Pay',
    sentence: 'When you open Nave Pay, this is the first thing you see. To collect is what customers still owe. Overdue is the part of that which is past due. To pay is what the treasury still owes. Chains tells you how many networks share these books.',
  },
  {
    id: 'pay-nav',
    target: 'tour-nav',
    navPath: '/pay',
    product: 'pay',
    page: 'pay',
    title: 'Pay navigation',
    sentence: 'This menu is for the books. Home is the summary you just saw. Invoices, Customers, and Bills are the records you work with day to day. More books opens vendors, the bank feed, payroll, the ledger, and reports.',
  },
  {
    id: 'quick',
    target: 'tour-topbar',
    navPath: '/pay',
    product: 'pay',
    page: 'pay',
    title: 'Header',
    sentence: 'These controls stay at the top of every page. Search finds something in the treasury, the bell is your notifications, the network menu changes which network you are on, and Add funds brings money in.',
  },
];
