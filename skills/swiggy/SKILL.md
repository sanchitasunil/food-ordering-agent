---
name: swiggy
description: "Order food on Swiggy in India via Swiggy's MCP server. Food delivery only. Address-aware: every search/cart/order action requires an addressId fetched from the user's saved Swiggy addresses."
---

# Swiggy Skill

Order food on Swiggy in India via Swiggy's MCP gateway. Currently only the
`swiggy-food` server is wired up. Instamart and Dineout require their own MCP
servers in `config/mcporter.json` and are not yet supported.

## Installation

The skill CLI lives at `skills/swiggy/swiggy-cli.js`. Run it via:

```bash
node skills/swiggy/swiggy-cli.js food <command> [args]
```

Do NOT rely on a global `swiggy` binary — OpenClaw's shell executor may not
have npm globals on PATH. Always use the full `node skills/swiggy/swiggy-cli.js`
invocation.

One-time auth (interactive, opens a browser):

```bash
mcporter auth swiggy-food
```

## CRITICAL: Address-first workflow

**Almost every food tool requires an `addressId`** — a real ID belonging to one
of the user's saved Swiggy delivery addresses. There is no free-form location
parameter. The workflow is:

1. Call `node skills/swiggy/swiggy-cli.js food addresses` to fetch the user's saved addresses.
2. If the list is empty, tell the user to add a delivery address in the Swiggy
   mobile app and stop. Do not invent an addressId.
3. If there's exactly one address, use it.
4. If there are multiple, present them numbered to the user and ask which to
   use. Hold the chosen `addressId` in conversation state and pass it to every
   subsequent food command.

## When to Use

- "Order biryani" → `food search` → `food menu` → `food dishes` → `food cart-add` → preview → `food order --confirm`
- "What's open near me?" → `food search "<cuisine>"`
- "Track my order" → `food track`
- "Show my recent orders" → `food orders --address-id <id>`

## Available Commands

```bash
# Address discovery (ALWAYS run first if you don't have an addressId)
node skills/swiggy/swiggy-cli.js food addresses

# Restaurants & menus
node skills/swiggy/swiggy-cli.js food search "<query>" --address-id <id>
node skills/swiggy/swiggy-cli.js food menu <restaurant-id> --address-id <id> [--page <n>] [--page-size <n>]
node skills/swiggy/swiggy-cli.js food dishes "<query>" --address-id <id> [--restaurant <id>] [--veg]

# Cart
node skills/swiggy/swiggy-cli.js food cart --address-id <id>
node skills/swiggy/swiggy-cli.js food cart-add --restaurant <id> --address-id <id> --item <menu-item-id> [--quantity <n>]
node skills/swiggy/swiggy-cli.js food cart-clear

# Coupons
node skills/swiggy/swiggy-cli.js food coupons --restaurant <id> --address-id <id> [--code <code>]
node skills/swiggy/swiggy-cli.js food apply-coupon --code <code> --address-id <id>

# Order placement & tracking
node skills/swiggy/swiggy-cli.js food order --address-id <id> --confirm [--payment <method>]
node skills/swiggy/swiggy-cli.js food orders --address-id <id> [--count <n>]
node skills/swiggy/swiggy-cli.js food order-details <orderId>
node skills/swiggy/swiggy-cli.js food track [<orderId>]
```

## Item selection rules

- **`food menu`** returns a compact view with `hasVariants` and `hasAddons` flags.
- **`food dishes`** returns full item details including `menu_item_id`, variants,
  and addons. Use `dishes` (not `menu`) to get the `menu_item_id` you need for
  `cart-add`.
- **`cart-add`** in this CLI only supports SIMPLE items — items where both
  `hasVariants` is false and `hasAddons` is false. For items with variants or
  addons, you must drive `update_food_cart` directly via mcporter:
  ```bash
  mcporter call swiggy-food.update_food_cart --args '<json>'
  ```
  with a `cartItems` array carrying the right `variants`/`variantsV2`/`addons`
  shapes per the schema. Most users won't need this for casual orders.

## CRITICAL: Safety Rules

### NEVER auto-order
**ALWAYS get explicit confirmation before placing orders.**

1. Show a cart preview first (`node skills/swiggy/swiggy-cli.js food cart --address-id <id>`):
   - All items with quantities and prices
   - Subtotal, delivery, taxes, and `to_pay` total
   - Delivery address (full address from `get_addresses`)
   - Available payment methods (will be `["Cash"]` only)

2. Read the preview to the user and ask for confirmation:
   ```
   Ready to order:
   - 1x Pepper Chicken (₹360)
   Subtotal: ₹360 + ₹44 delivery + ₹59.25 tax
   Total to pay: ₹463 (Cash on Delivery)
   Deliver to: <full address from get_addresses>

   Confirm order? (yes/no)
   ```

3. Only after the user clearly says yes:
   - Run `node skills/swiggy/swiggy-cli.js food order --address-id <id> --confirm`
   - Optionally log to `memory/swiggy-orders.json`

### COD-only and ₹1000 cap
- Swiggy MCP currently supports **Cash on Delivery only**. The `availablePaymentMethods` field in `get_food_cart` will reflect this — never assume any other payment method.
- Order placement is **blocked for cart values ≥ ₹1000** (Swiggy MCP beta restriction). For larger orders, tell the user to use the Swiggy app instead — the MCP cart syncs to the app.
- Orders **cannot be cancelled** once placed via MCP. For cancellation, tell the user: *"To cancel your order, please call Swiggy customer care at 080-67466729."*

### Address handling
- Never invent an `addressId`. Always fetch from `get_addresses`.
- The address string in `get_addresses` includes the full street, area, postal code, and the user's name and masked phone — read it back when confirming.

## Workflow examples

### Simple food order (single, no-variant item)

```bash
# 1. Get addressId
node skills/swiggy/swiggy-cli.js food addresses
# → user has address d7bo18tdmtl1u1bd1kng (Electronic City)

# 2. Search restaurants
node skills/swiggy/swiggy-cli.js food search "biryani" --address-id d7bo18tdmtl1u1bd1kng
# → Meghana Foods (id 86358), OPEN

# 3. Browse menu (compact) to find an item
node skills/swiggy/swiggy-cli.js food menu 86358 --address-id d7bo18tdmtl1u1bd1kng

# 4. Get full item details (gives menu_item_id)
node skills/swiggy/swiggy-cli.js food dishes "pepper chicken" --address-id d7bo18tdmtl1u1bd1kng --restaurant 86358
# → Pepper Chicken, menu_item_id 24794114, hasVariants false, hasAddons false

# 5. Add to cart
node skills/swiggy/swiggy-cli.js food cart-add --restaurant 86358 --address-id d7bo18tdmtl1u1bd1kng --item 24794114 --quantity 1

# 6. Preview cart and read to user
node skills/swiggy/swiggy-cli.js food cart --address-id d7bo18tdmtl1u1bd1kng

# 7. Get explicit user confirmation, then place order
node skills/swiggy/swiggy-cli.js food order --address-id d7bo18tdmtl1u1bd1kng --confirm
```

### Order tracking

```bash
node skills/swiggy/swiggy-cli.js food track
# → all active orders, or "No active orders to track"
```

### Browsing without committing

```bash
node skills/swiggy/swiggy-cli.js food search "pizza" --address-id <id>
node skills/swiggy/swiggy-cli.js food menu <restaurantId> --address-id <id> --page 1 --page-size 8
node skills/swiggy/swiggy-cli.js food dishes "margherita" --address-id <id> --restaurant <restaurantId>
```

## Error handling

- **Empty address list:** Tell the user to add an address in the Swiggy app.
- **No restaurants for query:** Suggest a broader query or different cuisine.
- **`hasVariants: true` item requested via cart-add:** Explain that variant items
  need to drive `update_food_cart` directly via mcporter, or pick a simpler item.
- **Cart total ≥ ₹1000 at order time:** Explain the MCP beta cap and suggest the
  Swiggy app for larger orders.
- **Auth errors from mcporter:** Run `mcporter auth swiggy-food` (note the
  Windows OAuth URL-truncation workaround if applicable).

## Order logging

After a successful `place_food_order`, append to `memory/swiggy-orders.json`:

```json
{
  "timestamp": "2026-04-09T13:00:00+05:30",
  "type": "food",
  "restaurant": "Meghana Foods",
  "items": [{ "name": "Pepper Chicken", "quantity": 1, "price": 360 }],
  "total": "₹463",
  "addressId": "d7bo18tdmtl1u1bd1kng",
  "orderId": "..."
}
```

## Dependencies

- `mcporter` v0.8.x on PATH (used by the CLI under the hood)
- Node.js runtime for the CLI wrapper
- An authenticated `swiggy-food` server in `config/mcporter.json`

## Known limitations

- COD only (no online payment)
- Orders cannot be cancelled via MCP
- Cart total must be < ₹1000 to place an order (beta restriction)
- Variant/addon items not supported by `cart-add` (simple items only)
- Instamart and Dineout not yet wired up
- Don't open the Swiggy app while using MCP — session conflicts can occur

---

**Remember: addressId from `get_addresses` first. Confirmation BEFORE ordering. Every. Single. Time.**
