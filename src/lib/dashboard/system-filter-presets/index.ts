import { acquisitionPresets } from "./acquisition";
import { dataQualityPresets } from "./dataQuality";
import { devicePresets } from "./device";
import { eventConversionPresets } from "./eventConversion";
import { pageContentPresets } from "./pageContent";
import { performancePresets } from "./performance";
import { sessionEngagementPresets } from "./sessionEngagement";
import { userJourneyPresets } from "./userJourney";
import { visitorBehaviorPresets } from "./visitorBehavior";

export const EXPANDED_SYSTEM_FILTER_PRESETS = [
  ...acquisitionPresets,
  ...devicePresets,
  ...pageContentPresets,
  ...eventConversionPresets,
  ...sessionEngagementPresets,
  ...visitorBehaviorPresets,
  ...userJourneyPresets,
  ...performancePresets,
  ...dataQualityPresets,
] as const;
