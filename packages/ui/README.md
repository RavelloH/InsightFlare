# @insightflare/ui

Reusable, accessible React UI primitives used by [InsightFlare](https://github.com/RavelloH/InsightFlare).

Designed for **React 19** and **Tailwind CSS 4**. Components are individually exported so applications can import only what they need.

## Install

```sh
pnpm add @insightflare/ui
```

Ensure your application has compatible `react`, `react-dom`, and `tailwindcss` peer dependencies installed.

## Use

Import the shared stylesheet once in your application's main stylesheet or client entry point:

```css
@import "@insightflare/ui/styles.css";
@source "../node_modules/@insightflare/ui";
```

Use individual components:

```tsx
import { Button } from "@insightflare/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@insightflare/ui/card";
import { Badge } from "@insightflare/ui/badge";

export function Example() {
  return (
    <Card>
      <CardHeader><CardTitle>Analytics</CardTitle></CardHeader>
      <CardContent>
        <Badge>Connected</Badge>
        <Button>View dashboard</Button>
      </CardContent>
    </Card>
  );
}
```

Apply the `dark` class to your page root for the dark color palette. The component library provides tokens and styles; application layout and domain-specific analytics UI belong in the consuming app or [`@insightflare/product-ui`](https://github.com/RavelloH/InsightFlare/tree/main/packages/product-ui).

## Exports

Components include buttons, cards, forms, dialogs, drawers, tooltips, select controls, sidebars, tables, chart primitives, scrolling and layout utilities. See `package.json` exports for the supported entry points.

## Source and license

Source: [InsightFlare/packages/ui](https://github.com/RavelloH/InsightFlare/tree/main/packages/ui). MIT licensed.
