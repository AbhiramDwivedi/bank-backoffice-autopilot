/**
 * A small div-and-flexbox web shop, served on an ephemeral port, for testing that discovery and
 * replay are not tailored to the mock app's table markup. The markup and wording are this repo's
 * own; the shop is called "Demo Shop".
 *
 * It is shaped like a typical modern shop, not like the mock app: no tables, no frames, no
 * adjacent-cell labels. Sign-in is a form whose fields are named only by their placeholders. The
 * product list is a CSS grid of cards; in each card the product title is a <div> inside a link,
 * followed by a summary <div>, and a footer holding a price <div> and an "Add to cart" button.
 * The price sits below the summary, so the text directly above it is the summary, not the title.
 * Each card also has an image link whose accessible name repeats the title, so a role locator on
 * the title is ambiguous, as it is on real shops. A product with `price: null` is sold out: its
 * card has no price element at all. With `namedAddButtons`, each "Add to cart" button's accessible
 * name holds its product ("Add Bike Light to cart").
 *
 * The orders page lists order cards: a reference, a placed-on line, and a status <span> whose
 * class is slugged from its text (`state-in-transit`), a common pattern that ties a class
 * selector to the record's value.
 *
 * A product may also carry a struck-through list price above its price (both in the same
 * `product-cost` class), or a nested card of another product inside its own (a gift set holding
 * a mug), the two shapes where "the price inside this card" is ambiguous.
 *
 * "Add to cart" posts the product id to /cart; the server records every add (`cart`), so a test
 * can tell which product a replay actually clicked. The order table (/order-table) is a plain
 * <table> of order id and status; the rows page (/rows) is a table of clickable rows ("Row for
 * 4512") that open /rows/<id>, recorded in `rowVisits`.
 *
 * The people search lists every person whose name contains the query (case-insensitive substring,
 * so "Smith" lists Jane Smith and Al Smithers): a table of name, e-mail and a "View" button that
 * opens /people/<id>, recorded in `peopleViews`. GET /people?q= and POST /people are the two
 * variants (a search in the URL, a search the URL does not show). The order search
 * (/order-search?q=) lists orders whose id contains the query: order, customer, status. The order
 * list (/order-list) is a table of "Order <no>", the date placed and the status, so an order number
 * can also appear inside another order's date ("Order 3005 | 03/02/2001").
 *
 * Routes: GET /login, POST /login (cookie session), GET /products, GET /products/:id, POST /cart,
 * GET /orders, GET /order-table, GET /order-list, GET /rows, GET /rows/:id, GET|POST /people,
 * GET /people/:id, GET /order-search, GET /logout. Unauthenticated requests for the others redirect to /login.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/** One product the shop lists. */
export interface StoreProduct {
  id: number;
  name: string;
  description: string;
  /** Displayed as `$<price>` with two decimals; null = sold out (no price element). */
  price: number | null;
  /** A struck-through list price shown above `price`, in the same class. */
  listPrice?: number;
  /** A nested card of another product inside this one's (a set holding an item). */
  inner?: StoreProduct;
}

/** One row of the plain order table. */
export interface TableOrder {
  id: string;
  status: string;
}

/** One order on the orders page. */
export interface StoreOrder {
  ref: string;
  placed: string;
  status: string;
}

/** The demo shopper's credentials. Test-only values, like the mock app's demo login. */
export const STORE_USER = 'demo_shopper';
export const STORE_PASSWORD = 'shop-demo-pass-77';
/** The shop's name, shown in the header of every page. */
export const STORE_NAME = 'Demo Shop';

/** The standard catalogue. Two products share a price on purpose, so a price's text is not unique;
 *  one name is full of CSS, regex and template characters; one summary mentions "Trail Lamp". */
export const STORE_PRODUCTS: readonly StoreProduct[] = [
  { id: 1, name: 'Canvas Backpack', description: 'Water-resistant canvas pack with a padded laptop sleeve.', price: 29.99 },
  { id: 2, name: 'Bike Light', description: 'Rechargeable front light with three brightness modes.', price: 9.99 },
  { id: 3, name: 'Graphic T-Shirt', description: 'Soft cotton tee with a screen-printed logo.', price: 15.99 },
  { id: 4, name: 'Fleece Jacket', description: 'Midweight fleece for cool mornings and evenings.', price: 49.99 },
  { id: 5, name: 'Camp Mug {12 oz} (2-pack) [v2] *', description: 'Enamel mugs that pair well with the Trail Lamp.', price: 18.5 },
  { id: 6, name: 'Red Hoodie', description: 'Pullover hoodie with a front pocket.', price: 15.99 },
];

/** The standard orders. Two share a status, so the status text alone names no order. */
export const STORE_ORDERS: readonly StoreOrder[] = [
  { ref: 'ALPHA', placed: 'Placed on 2 September', status: 'In transit' },
  { ref: 'BRAVO', placed: 'Placed on 9 September', status: 'Delivered' },
  { ref: 'CHARLIE', placed: 'Placed on 15 September', status: 'In transit' },
];

/** The standard order table. */
export const STORE_TABLE_ORDERS: readonly TableOrder[] = [
  { id: 'A-1001', status: 'Shipped' },
  { id: 'B-2002', status: 'Pending' },
  { id: 'C-3003', status: 'Cancelled' },
];

/** One person in the people search. */
export interface StorePerson {
  id: number;
  name: string;
  email: string;
}

/** The people search's directory: "Smith" matches two, "Jones" five, "Lee" one. */
export const STORE_PEOPLE: readonly StorePerson[] = [
  { id: 1, name: 'Jane Smith', email: 'jane.smith@example.test' },
  { id: 2, name: 'Al Smithers', email: 'al.sm@example.test' },
  { id: 3, name: 'Ann Jones', email: 'ann.j@example.test' },
  { id: 4, name: 'Bob Jones', email: 'bob.j@example.test' },
  { id: 5, name: 'Cy Jones', email: 'cy.j@example.test' },
  { id: 6, name: 'Di Jones', email: 'di.j@example.test' },
  { id: 7, name: 'Ed Jones', email: 'ed.j@example.test' },
  { id: 8, name: 'Bo Lee', email: 'bo.l@example.test' },
];

/** One row of the order search. */
export interface SearchOrder {
  id: string;
  customer: string;
  status: string;
}

/** The order search's orders: "A-1001" also matches A-10010. */
export const STORE_SEARCH_ORDERS: readonly SearchOrder[] = [
  { id: 'A-1001', customer: 'Bo Lee', status: 'Pending' },
  { id: 'A-10010', customer: 'Jane Roe', status: 'Shipped' },
  { id: 'B-2002', customer: 'Ann Jones', status: 'Cancelled' },
];

/** One row of the order list. */
export interface ListedOrder {
  /** The whole cell, e.g. "Order 2001". */
  order: string;
  placed: string;
  status: string;
}

/** The standard order list: every order cell reads "Order <no>". */
export const STORE_ORDER_LIST: readonly ListedOrder[] = [
  { order: 'Order 3005', placed: '07/04/2019', status: 'Open' },
  { order: 'Order 4000', placed: '08/04/2019', status: 'Closed' },
  { order: 'Order 2001', placed: '05/04/2019', status: 'Shipped' },
  { order: 'Order A-1001', placed: '06/04/2019', status: 'Held' },
];

/** The standard clickable rows: one id is a prefix of the other. */
export const STORE_ROW_IDS: readonly string[] = ['4512', '45123'];

/** What a shop instance serves. */
export interface StorefrontOptions {
  products?: readonly StoreProduct[];
  /** How the people search sends its query: in the URL (default) or in a POST body. */
  peopleSearch?: 'get' | 'post';
  orders?: readonly StoreOrder[];
  tableOrders?: readonly TableOrder[];
  rowIds?: readonly string[];
  orderList?: readonly ListedOrder[];
  /** The people search's directory (default {@link STORE_PEOPLE}). */
  people?: readonly StorePerson[];
  /** Give each "Add to cart" button an accessible name holding its product ("Add Bike Light to
   *  cart"), as shops that label repeated buttons for screen readers do. Default false. */
  namedAddButtons?: boolean;
}

/** A running shop. */
export interface Storefront {
  /** http://localhost:<port> */
  baseUrl: string;
  /** Every request (method + path), in order. */
  requests: { method: string; path: string }[];
  /** Product ids added to the cart, in order. */
  cart: number[];
  /** Row ids opened from the rows page, in order. */
  rowVisits: string[];
  /** Person ids opened from the people search, in order. */
  peopleViews: number[];
  close(): Promise<void>;
}

const SESSION_COOKIE = 'demo_shop_sid';

/** 1x1 grey GIF, so product images have a real, decoded box. */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAMzMzAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==';

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #1d2433; background: #fff; }
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 24px; border-bottom: 1px solid #ddd; }
.shop-name { font-size: 24px; font-weight: bold; }
.topbar-links { display: flex; gap: 16px; }
.page-heading { padding: 8px 24px; font-size: 18px; font-weight: 600; }
.signin-wrap { display: flex; justify-content: center; padding-top: 60px; }
.signin-form { display: flex; flex-direction: column; gap: 12px; width: 320px; }
.signin-form input { width: 100%; padding: 10px; font-size: 15px; }
.signin-problem { color: #a40000; font-size: 14px; }
.catalog { display: grid; grid-template-columns: repeat(2, 480px); gap: 20px; padding: 20px 24px; }
.product-card { display: flex; gap: 12px; border: 1px solid #ddd; border-radius: 6px; padding: 12px; }
.product-thumb img { width: 96px; height: 96px; display: block; }
.product-info { display: flex; flex-direction: column; justify-content: space-between; flex: 1; gap: 8px; }
.product-title { font-size: 18px; font-weight: 500; color: #1b4f8a; }
.product-summary { font-size: 13px; color: #444; }
.product-footer { display: flex; align-items: center; justify-content: space-between; }
.product-cost { font-size: 18px; font-weight: 600; }
.sold-out-note { font-size: 14px; color: #888; }
.add-button { padding: 6px 12px; border: 1px solid #1d2433; background: #fff; cursor: pointer; }
.product-page { display: flex; gap: 24px; padding: 24px; }
.product-page-text { display: flex; flex-direction: column; gap: 12px; }
.product-page-title { font-size: 22px; font-weight: 600; }
.product-page-cost { font-size: 20px; }
.order-list { display: flex; flex-direction: column; gap: 12px; padding: 20px 24px; width: 520px; }
.order-card { display: flex; flex-direction: column; gap: 6px; border: 1px solid #ddd; border-radius: 6px; padding: 12px; }
.order-ref { font-size: 18px; font-weight: 600; }
.order-placed { font-size: 13px; color: #555; }
.state { font-size: 14px; }
a { text-decoration: none; }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function topbar(): string {
  return `<div class="topbar"><div class="shop-name">${STORE_NAME}</div><div class="topbar-links"><a href="/products">Products</a><a href="/orders">Your orders</a><a href="/order-table">Order table</a><a href="/order-list">Order list</a><a href="/rows">Rows</a><a href="/people">People</a><a href="/order-search">Order search</a><a href="/logout">Sign out</a></div></div>`;
}

function signInPage(problem?: string): string {
  return page(
    STORE_NAME,
    `<div class="topbar"><div class="shop-name">${STORE_NAME}</div></div>
<div class="signin-wrap"><form class="signin-form" method="post" action="/login">
  <div class="field"><input placeholder="Username" type="text" id="login-name" name="login-name" autocomplete="off"></div>
  <div class="field"><input placeholder="Password" type="password" id="login-secret" name="login-secret" autocomplete="off"></div>
  ${problem ? `<div class="signin-problem">${escapeHtml(problem)}</div>` : ''}
  <input type="submit" id="sign-in" value="Sign in">
</form></div>`,
  );
}

function card(p: StoreProduct, namedAdd: boolean): string {
  // Title inside a link inside a div; summary div; a footer with the price div (currency sign in
  // its own span) and a button. A sold-out product has no price element at all.
  const list = p.listPrice !== undefined ? `<div class="product-cost"><s>$${p.listPrice.toFixed(2)}</s></div>` : '';
  const cost = p.price === null ? '<div class="sold-out-note">Sold out</div>' : `${list}<div class="product-cost"><span class="currency">$</span>${p.price.toFixed(2)}</div>`;
  const label = namedAdd ? ` aria-label="Add ${escapeHtml(p.name)} to cart"` : '';
  const add =
    p.price === null
      ? `<button class="add-button"${label} disabled>Add to cart</button>`
      : `<form method="post" action="/cart" class="add-form"><input type="hidden" name="id" value="${p.id}"><button class="add-button"${label}>Add to cart</button></form>`;
  return `<div class="product-card">
  <div class="product-thumb"><a href="/products/${p.id}"><img alt="${escapeHtml(p.name)}" src="${PIXEL}"></a></div>
  <div class="product-info">
    <div class="product-heading">
      <a href="/products/${p.id}" id="title-link-${p.id}"><div class="product-title">${escapeHtml(p.name)}</div></a>
      <div class="product-summary">${escapeHtml(p.description)}</div>
    </div>
    <div class="product-footer">
      ${cost}
      ${add}
    </div>
    ${p.inner ? card(p.inner, namedAdd) : ''}
  </div>
</div>`;
}

function catalogPage(products: readonly StoreProduct[], namedAdd: boolean): string {
  return page(STORE_NAME, `${topbar()}\n<div class="page-heading">Products</div>\n<div class="catalog">${products.map((p) => card(p, namedAdd)).join('\n')}</div>`);
}

function productPage(p: StoreProduct): string {
  return page(
    STORE_NAME,
    `${topbar()}
<div class="product-page">
  <img class="product-page-img" alt="${escapeHtml(p.name)}" src="${PIXEL}" width="200" height="200">
  <div class="product-page-text">
    <div class="product-page-title">${escapeHtml(p.name)}</div>
    <div class="product-page-summary">${escapeHtml(p.description)}</div>
    <div class="product-page-cost">${p.price === null ? 'Sold out' : money(p.price)}</div>
    <button class="add-button">Add to cart</button>
  </div>
</div>`,
  );
}

function ordersPage(orders: readonly StoreOrder[]): string {
  const cards = orders
    .map(
      (o) => `<div class="order-card">
  <div class="order-ref">${escapeHtml(o.ref)}</div>
  <div class="order-placed">${escapeHtml(o.placed)}</div>
  <div class="order-state-line"><span class="state state-${slug(o.status)}">${escapeHtml(o.status)}</span></div>
</div>`,
    )
    .join('\n');
  return page(STORE_NAME, `${topbar()}\n<div class="page-heading">Your orders</div>\n<div class="order-list">${cards}</div>`);
}

function orderTablePage(rows: readonly TableOrder[]): string {
  const body = rows.map((o) => `<tr><td>${escapeHtml(o.id)}</td><td>${escapeHtml(o.status)}</td></tr>`).join('');
  return page(
    STORE_NAME,
    `${topbar()}\n<div class="page-heading">Order table</div>\n<table border="1" cellpadding="4"><tr><th>Order</th><th>Status</th></tr>${body}</table>`,
  );
}

function orderListPage(rows: readonly ListedOrder[]): string {
  const body = rows.map((o) => `<tr><td>${escapeHtml(o.order)}</td><td>${escapeHtml(o.placed)}</td><td>${escapeHtml(o.status)}</td></tr>`).join('');
  return page(
    STORE_NAME,
    `${topbar()}\n<div class="page-heading">Order list</div>\n<table border="1" cellpadding="4"><tr><th>Order</th><th>Placed</th><th>Status</th></tr>${body}</table>`,
  );
}

function rowsPage(ids: readonly string[]): string {
  const body = ids.map((id) => `<tr onclick="location.href='/rows/${encodeURIComponent(id)}'" style="cursor:pointer"><td>Row for ${escapeHtml(id)}</td></tr>`).join('');
  return page(STORE_NAME, `${topbar()}\n<div class="page-heading">Rows</div>\n<table border="1" cellpadding="4">${body}</table>`);
}

function peoplePage(method: 'get' | 'post', q: string | null, people: readonly StorePerson[]): string {
  const hits = q === null ? [] : people.filter((x) => x.name.toLowerCase().includes(q.toLowerCase()));
  const rows = hits
    .map((x) => `<tr><td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.email)}</td><td><button class="view-person" onclick="location.href='/people/${x.id}'">View</button></td></tr>`)
    .join('');
  const results = q === null ? '' : `<table border="1" cellpadding="4" class="people-results"><tr><th>Name</th><th>E-mail</th><th></th></tr>${rows}</table>`;
  return page(
    STORE_NAME,
    `${topbar()}\n<div class="page-heading">People</div>\n<form method="${method}" action="/people" class="people-search"><input type="text" name="q" placeholder="Name"> <button type="submit" class="search-people">Search</button></form>\n${results}`,
  );
}

function orderSearchPage(q: string | null, orders: readonly SearchOrder[]): string {
  const hits = q === null ? [] : orders.filter((o) => o.id.toLowerCase().includes(q.toLowerCase()));
  const rows = hits.map((o) => `<tr><td>${escapeHtml(o.id)}</td><td>${escapeHtml(o.customer)}</td><td>${escapeHtml(o.status)}</td></tr>`).join('');
  const results = q === null ? '' : `<table border="1" cellpadding="4" class="order-results"><tr><th>Order</th><th>Customer</th><th>Status</th></tr>${rows}</table>`;
  return page(
    STORE_NAME,
    `${topbar()}\n<div class="page-heading">Order search</div>\n<form method="get" action="/order-search"><input type="text" name="q" placeholder="Order id"> <button type="submit">Find</button></form>\n${results}`,
  );
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

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
}

function redirect(res: ServerResponse, location: string, cookie?: string): void {
  res.writeHead(302, { location, ...(cookie !== undefined ? { 'set-cookie': cookie } : {}) }).end();
}

/** Starts a shop on an ephemeral port (dual-stack, so "localhost" works either way). */
export async function startStorefront(opts: StorefrontOptions = {}): Promise<Storefront> {
  const products = opts.products ?? STORE_PRODUCTS;
  const orders = opts.orders ?? STORE_ORDERS;
  const tableOrders = opts.tableOrders ?? STORE_TABLE_ORDERS;
  const rowIds = opts.rowIds ?? STORE_ROW_IDS;
  const orderList = opts.orderList ?? STORE_ORDER_LIST;
  const people = opts.people ?? STORE_PEOPLE;
  const cart: number[] = [];
  const peopleViews: number[] = [];
  const peopleSearch = opts.peopleSearch ?? 'get';
  const rowVisits: string[] = [];
  const sessions = new Set<string>();
  const requests: { method: string; path: string }[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    requests.push({ method, path: url.pathname });
    const signedIn = sessions.has(cookieOf(req, SESSION_COOKIE) ?? '');
    void (async () => {
      if (method === 'GET' && url.pathname === '/') return redirect(res, signedIn ? '/products' : '/login');
      if (method === 'GET' && url.pathname === '/login') return send(res, 200, signInPage());
      if (method === 'POST' && url.pathname === '/login') {
        const form = new URLSearchParams(await readBody(req));
        if (form.get('login-name') === STORE_USER && form.get('login-secret') === STORE_PASSWORD) {
          const sid = randomUUID();
          sessions.add(sid);
          return redirect(res, '/products', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
        }
        return send(res, 200, signInPage('The sign-in details were not recognised.'));
      }
      if (method === 'GET' && url.pathname === '/logout') {
        sessions.delete(cookieOf(req, SESSION_COOKIE) ?? '');
        return redirect(res, '/login', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
      }
      if (!signedIn) return redirect(res, '/login');
      if (method === 'GET' && url.pathname === '/products') return send(res, 200, catalogPage(products, opts.namedAddButtons === true));
      if (method === 'GET' && url.pathname === '/orders') return send(res, 200, ordersPage(orders));
      if (method === 'GET' && url.pathname === '/order-table') return send(res, 200, orderTablePage(tableOrders));
      if (method === 'GET' && url.pathname === '/rows') return send(res, 200, rowsPage(rowIds));
      const row = /^\/rows\/([^/]+)$/.exec(url.pathname);
      if (method === 'GET' && row) {
        const id = decodeURIComponent(row[1]!);
        rowVisits.push(id);
        return send(res, 200, page(STORE_NAME, `${topbar()}\n<div class="page-heading">Row ${escapeHtml(id)} details</div>`));
      }
      if (url.pathname === '/people') {
        if (method === 'POST') return send(res, 200, peoplePage(peopleSearch, new URLSearchParams(await readBody(req)).get('q') ?? '', people));
        return send(res, 200, peoplePage(peopleSearch, peopleSearch === 'get' ? url.searchParams.get('q') : null, people));
      }
      const person = /^\/people\/(\d+)$/.exec(url.pathname);
      if (method === 'GET' && person) {
        const x = people.find((y) => y.id === Number(person[1]));
        if (!x) return send(res, 404, page('Not found', '<div>No such person</div>'));
        peopleViews.push(x.id);
        return send(res, 200, page(STORE_NAME, `${topbar()}\n<div class="page-heading">Contact</div>\n<div class="contact-card"><div class="contact-label">E-mail</div><div class="contact-email">${escapeHtml(x.email)}</div></div>`));
      }
      if (method === 'GET' && url.pathname === '/order-list') return send(res, 200, orderListPage(orderList));
      if (method === 'GET' && url.pathname === '/order-search') return send(res, 200, orderSearchPage(url.searchParams.get('q'), STORE_SEARCH_ORDERS));
      if (method === 'POST' && url.pathname === '/cart') {
        const form = new URLSearchParams(await readBody(req));
        cart.push(Number(form.get('id')));
        return redirect(res, '/products');
      }
      const item = /^\/products\/(\d+)$/.exec(url.pathname);
      if (method === 'GET' && item) {
        const p = products.find((x) => x.id === Number(item[1]));
        return p ? send(res, 200, productPage(p)) : send(res, 404, page('Not found', `${topbar()}<div class="page-heading">No such product</div>`));
      }
      return send(res, 404, page('Not found', '<div>Not found</div>'));
    })().catch(() => {
      if (!res.headersSent) send(res, 500, page('Error', '<div>Error</div>'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    cart,
    rowVisits,
    peopleViews,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
