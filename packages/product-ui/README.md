# @insightflare/product-ui

Reusable, props-driven analytics components from [InsightFlare](https://github.com/RavelloH/InsightFlare). Built for React 19 and designed to work with [`@insightflare/ui`](https://www.npmjs.com/package/@insightflare/ui).

## Install

```sh
pnpm add @insightflare/ui @insightflare/product-ui
```

Install the React peer dependencies and Tailwind CSS 4 as appropriate for your application.

## Use

Import the UI styles and product styles once from your application's stylesheet:

```css
@import "@insightflare/ui/styles.css";
@import "@insightflare/product-ui/styles.css";
```

Product-specific modules are exported individually:

```ts
import { /* components */ } from "@insightflare/product-ui/realtime";
import { /* components */ } from "@insightflare/product-ui/goals";
import { /* components */ } from "@insightflare/product-ui/funnel";
```

Additional exports include charts, tables, sharing, detail drawers, scope selectors, and tabbed tables. See `package.json` for the complete public entry points.

The product components are props-only: callers supply the analytics data and actions. They do not connect to a particular InsightFlare deployment or API by themselves.

The source of both packages lives in the [InsightFlare monorepo](https://github.com/RavelloH/InsightFlare). MIT licensed.
