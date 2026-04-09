#!/usr/bin/env node

/**
 * Swiggy food MCP via mcporter (see config/mcporter.json). Other Swiggy MCP
 * servers need registering + auth before adding dispatch here. Most commands
 * need --address-id from `swiggy food addresses`.
 */

const { spawnSync } = require('child_process');

const SERVER = 'swiggy-food';
const isWindows = process.platform === 'win32';

/**
 * mcporter call with --args JSON. Windows: double-quote + escape ""; Unix:
 * single-quote — avoids cmd/PowerShell eating quotes before mcporter runs.
 */
function callMCP(tool, args = {}) {
  const selector = `${SERVER}.${tool}`;
  const hasArgs = args && Object.keys(args).length > 0;

  let cmd;
  if (!hasArgs) {
    cmd = `mcporter call ${selector}`;
  } else {
    const argsJson = JSON.stringify(args);
    if (isWindows) {
      const escaped = argsJson.replace(/"/g, '""');
      cmd = `mcporter call ${selector} --args "${escaped}"`;
    } else {
      cmd = `mcporter call ${selector} --args '${argsJson}'`;
    }
  }

  const result = spawnSync(cmd, { encoding: 'utf8', shell: true });

  if (result.error) {
    console.error('Error:', result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.stderr) console.error(result.stderr);
    process.exit(result.status || 1);
  }
  return result.stdout;
}

function usage() {
  console.log(`
Swiggy CLI — Food delivery via Swiggy MCP

One-time setup:
  mcporter auth swiggy-food

Address discovery (do this first):
  swiggy food addresses
    List saved delivery addresses with their addressIds.

Restaurants & menus:
  swiggy food search <query> --address-id <id>
    Search restaurants for a delivery address.
  swiggy food menu <restaurant-id> --address-id <id> [--page <n>] [--page-size <n>]
    Browse a restaurant's menu (paginated; default page-size 5, max 8).
  swiggy food dishes <query> --address-id <id> [--restaurant <id>] [--veg]
    Search dishes/items globally or scoped to one restaurant.

Cart:
  swiggy food cart --address-id <id>
    Show current food delivery cart.
  swiggy food cart-add --restaurant <id> --address-id <id> --item <menu-item-id> [--quantity <n>]
    Add a SIMPLE (no-variant, no-addon) item to cart. For items with
    variants or addons, drive update_food_cart directly via:
      mcporter call swiggy-food.update_food_cart --args '<json>'
  swiggy food cart-clear
    Empty the cart.

Coupons:
  swiggy food coupons --restaurant <id> --address-id <id> [--code <code>]
    List or check applicability of coupons.
  swiggy food apply-coupon --code <code> --address-id <id>
    Apply a coupon to the cart.

Order placement & tracking:
  swiggy food order --address-id <id> --confirm [--payment <method>]
    Place the current cart as an order. --confirm is REQUIRED.
    Cart total must be < ₹1000 (Swiggy MCP beta restriction).
  swiggy food orders --address-id <id> [--count <n>]
    List recent orders (default 5, max 20).
  swiggy food order-details <orderId>
    Show full details for a specific order.
  swiggy food track [<orderId>]
    Track an active order, or all active orders if omitted.

Notes:
  - Instamart and Dineout aren't wired up. Register their MCP servers in
    config/mcporter.json and authenticate, then we can add commands.
  - Every tool except 'addresses', 'cart-clear', 'order-details', and
    'track' needs an --address-id from \`swiggy food addresses\`.
`);
}

function parseFlags(rest) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? next : true;
      flags[key] = value;
      if (value !== true) i++;
    } else {
      positional.push(tok);
    }
  }
  return { flags, positional };
}

function requireFlag(flags, key, action) {
  if (!flags[key] || flags[key] === true) {
    console.error(`ERROR: --${key} is required for '${action}'`);
    if (key === 'address-id') {
      console.error('Hint: run \`swiggy food addresses\` to see your addressIds.');
    }
    process.exit(1);
  }
  return flags[key];
}

function requirePositional(positional, index, name) {
  if (!positional[index]) {
    console.error(`ERROR: ${name} is required`);
    process.exit(1);
  }
  return positional[index];
}

function handleFood(action, positional, flags) {
  switch (action) {
    case 'addresses':
      return callMCP('get_addresses', {});

    case 'search': {
      const query = requirePositional(positional, 0, 'search query');
      const addressId = requireFlag(flags, 'address-id', 'food search');
      return callMCP('search_restaurants', { addressId, query });
    }

    case 'menu': {
      const restaurantId = requirePositional(positional, 0, 'restaurant id');
      const addressId = requireFlag(flags, 'address-id', 'food menu');
      const args = { addressId, restaurantId };
      if (flags.page) args.page = parseInt(flags.page, 10);
      if (flags['page-size']) args.pageSize = parseInt(flags['page-size'], 10);
      return callMCP('get_restaurant_menu', args);
    }

    case 'dishes': {
      const query = requirePositional(positional, 0, 'dish query');
      const addressId = requireFlag(flags, 'address-id', 'food dishes');
      const args = { addressId, query };
      if (flags.restaurant) args.restaurantIdOfAddedItem = flags.restaurant;
      if (flags.veg === true) args.vegFilter = 1;
      return callMCP('search_menu', args);
    }

    case 'cart': {
      const addressId = requireFlag(flags, 'address-id', 'food cart');
      return callMCP('get_food_cart', { addressId });
    }

    case 'cart-add': {
      const restaurantId = requireFlag(flags, 'restaurant', 'food cart-add');
      const addressId = requireFlag(flags, 'address-id', 'food cart-add');
      const itemId = requireFlag(flags, 'item', 'food cart-add');
      const quantity = parseInt(flags.quantity || '1', 10);
      return callMCP('update_food_cart', {
        restaurantId,
        addressId,
        cartItems: [{ menu_item_id: itemId, quantity }],
      });
    }

    case 'cart-clear':
      return callMCP('flush_food_cart', {});

    case 'coupons': {
      const restaurantId = requireFlag(flags, 'restaurant', 'food coupons');
      const addressId = requireFlag(flags, 'address-id', 'food coupons');
      const args = { restaurantId, addressId };
      if (flags.code) args.couponCode = flags.code;
      return callMCP('fetch_food_coupons', args);
    }

    case 'apply-coupon': {
      const couponCode = requireFlag(flags, 'code', 'food apply-coupon');
      const addressId = requireFlag(flags, 'address-id', 'food apply-coupon');
      return callMCP('apply_food_coupon', { couponCode, addressId });
    }

    case 'order': {
      if (!flags.confirm) {
        console.error('⚠️  ERROR: --confirm flag required to place order.');
        console.error('Review the cart first with: swiggy food cart --address-id <id>');
        process.exit(1);
      }
      const addressId = requireFlag(flags, 'address-id', 'food order');
      const args = { addressId };
      if (flags.payment) args.paymentMethod = flags.payment;
      return callMCP('place_food_order', args);
    }

    case 'orders': {
      const addressId = requireFlag(flags, 'address-id', 'food orders');
      const args = { addressId };
      if (flags.count) args.orderCount = parseInt(flags.count, 10);
      return callMCP('get_food_orders', args);
    }

    case 'order-details': {
      const orderId = requirePositional(positional, 0, 'orderId');
      return callMCP('get_food_order_details', { orderId });
    }

    case 'track': {
      const args = {};
      if (positional[0]) args.orderId = positional[0];
      return callMCP('track_food_order', args);
    }

    default:
      console.error(`Unknown food action: ${action}`);
      console.error('Run \`swiggy\` with no arguments to see available commands.');
      process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    usage();
    process.exit(0);
  }

  const [service, action, ...rest] = args;

  if (service !== 'food') {
    console.error(`Service '${service}' is not currently wired up.`);
    console.error('Only \`swiggy food ...\` is supported. Instamart and Dineout');
    console.error('need their MCP servers registered in config/mcporter.json first.');
    process.exit(1);
  }

  if (!action) {
    usage();
    process.exit(1);
  }

  const { flags, positional } = parseFlags(rest);
  const result = handleFood(action, positional, flags);
  if (result) console.log(result);
}

main();
