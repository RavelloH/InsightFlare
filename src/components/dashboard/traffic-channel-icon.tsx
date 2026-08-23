import {
  RiAdvertisementLine,
  RiCursorLine,
  RiLinksLine,
  RiMailLine,
  RiMegaphoneLine,
  RiMoneyDollarCircleLine,
  RiPriceTag3Line,
  RiQuestionLine,
  RiSearchLine,
  RiShareForwardLine,
} from "@remixicon/react";

import type { TrafficChannelId } from "@/lib/analytics/traffic-channel-rules";

export function TrafficChannelIcon({ channel }: { channel: TrafficChannelId }) {
  const className = "size-4 text-muted-foreground";
  switch (channel) {
    case "organic_search":
      return <RiSearchLine className={className} />;
    case "social":
      return <RiShareForwardLine className={className} />;
    case "paid_search":
      return <RiMoneyDollarCircleLine className={className} />;
    case "paid_social":
      return <RiMegaphoneLine className={className} />;
    case "display":
      return <RiAdvertisementLine className={className} />;
    case "email":
      return <RiMailLine className={className} />;
    case "affiliate":
    case "referral":
      return <RiLinksLine className={className} />;
    case "campaign":
      return <RiPriceTag3Line className={className} />;
    case "direct":
      return <RiCursorLine className={className} />;
    case "other":
      return <RiQuestionLine className={className} />;
  }
}
