import {
  and,
  caseWhen,
  coalesce,
  eq,
  filter,
  gte,
  inList,
  limit,
  neq,
  or,
  param,
  project,
  scalar,
  scan,
  schema,
  sort,
  update,
} from "@/lib/db";
import { sitePkRelationForSiteId } from "@/lib/edge/sites/identity-query";

type VisitsRelation = ReturnType<typeof scan<typeof schema.visits>>;

export function persistedRecentVisitorSessionQuery(input: {
  readonly siteId: string;
  readonly visitorId: string;
  readonly visitId: string;
  readonly cutoff: number;
  readonly routeMatchEnabled: number;
  readonly routePreviousHostname: string;
  readonly routePreviousPathname: string;
  readonly routePreviousQueryString: string;
  readonly routePreviousHashFragment: string;
}) {
  const visits = scan(schema.visits);
  const identity = scalar(sitePkRelationForSiteId(input.siteId));
  const matchingVisits = filter(
    visits,
    and(
      eq(visits.columns.site_pk, identity),
      eq(visits.columns.visitor_id, param(input.visitorId)),
      neq(visits.columns.visit_id, param(input.visitId)),
      neq(visits.columns.session_id, param("")),
      gte(visits.columns.last_activity_at, param(input.cutoff)),
    ),
  );
  const activeStatus = inList(matchingVisits.columns.status, [
    "open",
    "hidden_pending",
  ] as const);
  const exactRoute = and(
    eq(param(input.routeMatchEnabled), param(1)),
    activeStatus,
    eq(matchingVisits.columns.hostname, param(input.routePreviousHostname)),
    eq(matchingVisits.columns.pathname, param(input.routePreviousPathname)),
    eq(
      matchingVisits.columns.query_string,
      param(input.routePreviousQueryString),
    ),
    eq(
      matchingVisits.columns.hash_fragment,
      param(input.routePreviousHashFragment),
    ),
  );
  const compatibleRoute = and(
    eq(param(input.routeMatchEnabled), param(1)),
    activeStatus,
    eq(matchingVisits.columns.hostname, param(input.routePreviousHostname)),
    eq(matchingVisits.columns.pathname, param(input.routePreviousPathname)),
    orRoutePart(
      matchingVisits.columns.query_string,
      input.routePreviousQueryString,
    ),
    orRoutePart(
      matchingVisits.columns.hash_fragment,
      input.routePreviousHashFragment,
    ),
  );
  const routeMatch = caseWhen(
    [
      { when: exactRoute, then: param(2) },
      { when: compatibleRoute, then: param(1) },
    ],
    param(0),
  );
  const activeRank = caseWhen(
    [{ when: activeStatus, then: param(0) }],
    param(1),
  );
  const ranked = project(matchingVisits, {
    sessionId: matchingVisits.columns.session_id,
    visitId: matchingVisits.columns.visit_id,
    status: matchingVisits.columns.status,
    routeMatch,
    startedAt: matchingVisits.columns.started_at,
    lastActivityAt: matchingVisits.columns.last_activity_at,
    activeRank,
  });
  const ordered = sort(ranked, [
    { expression: ranked.columns.routeMatch, direction: "DESC" },
    { expression: ranked.columns.activeRank, direction: "ASC" },
    { expression: ranked.columns.lastActivityAt, direction: "DESC" },
    { expression: ranked.columns.startedAt, direction: "DESC" },
  ]);
  const top = limit(ordered, 1);
  return project(top, {
    sessionId: top.columns.sessionId,
    visitId: top.columns.visitId,
    status: top.columns.status,
    routeMatch: top.columns.routeMatch,
    startedAt: top.columns.startedAt,
    lastActivityAt: top.columns.lastActivityAt,
  });
}

function orRoutePart(
  expression: VisitsRelation["columns"]["query_string"],
  previousValue: string,
) {
  return or(
    eq(expression, param(previousValue)),
    eq(expression, param("")),
    eq(param(previousValue), param("")),
  );
}

export function persistedVisitRowQuery(siteId: string, visitId: string) {
  const visits = scan(schema.visits);
  const identity = scalar(sitePkRelationForSiteId(siteId));
  const matching = filter(
    visits,
    and(
      eq(visits.columns.site_pk, identity),
      eq(visits.columns.visit_id, param(visitId)),
    ),
  );
  return limit(
    project(matching, {
      visitId: matching.columns.visit_id,
      status: matching.columns.status,
      siteId: matching.columns.site_id,
      visitorId: matching.columns.visitor_id,
      sessionId: matching.columns.session_id,
      startedAt: matching.columns.started_at,
      lastActivityAt: matching.columns.last_activity_at,
      endedAt: matching.columns.ended_at,
      finalizedAt: matching.columns.finalized_at,
      durationMs: matching.columns.duration_ms,
      durationSource: coalesce(matching.columns.duration_source, param("")),
      exitReason: coalesce(matching.columns.exit_reason, param("")),
      pathname: matching.columns.pathname,
      queryString: matching.columns.query_string,
      hashFragment: matching.columns.hash_fragment,
      hostname: matching.columns.hostname,
      title: matching.columns.title,
      referrerUrl: matching.columns.referrer_url,
      referrerHost: matching.columns.referrer_host,
      utmSource: matching.columns.utm_source,
      utmMedium: matching.columns.utm_medium,
      utmCampaign: matching.columns.utm_campaign,
      utmTerm: matching.columns.utm_term,
      utmContent: matching.columns.utm_content,
      isEU: matching.columns.is_eu,
      country: matching.columns.country,
      region: matching.columns.region,
      regionCode: matching.columns.region_code,
      city: matching.columns.city,
      continent: matching.columns.continent,
      latitude: matching.columns.latitude,
      longitude: matching.columns.longitude,
      postalCode: matching.columns.postal_code,
      metroCode: matching.columns.metro_code,
      timezone: matching.columns.timezone,
      asOrganization: matching.columns.as_organization,
      uaRaw: matching.columns.ua_raw,
      browser: matching.columns.browser,
      browserVersion: matching.columns.browser_version,
      os: matching.columns.os,
      osVersion: matching.columns.os_version,
      deviceType: matching.columns.device_type,
      screenWidth: matching.columns.screen_width,
      screenHeight: matching.columns.screen_height,
      language: matching.columns.language,
      userId: coalesce(matching.columns.user_id, param("")),
      userName: coalesce(matching.columns.user_name, param("")),
      perfTtfbMs: matching.columns.perf_ttfb_ms,
      perfFcpMs: matching.columns.perf_fcp_ms,
      perfLcpMs: matching.columns.perf_lcp_ms,
      perfCls: matching.columns.perf_cls,
      perfInpMs: matching.columns.perf_inp_ms,
      createdAt: matching.columns.created_at,
      updatedAt: matching.columns.updated_at,
    }),
    1,
  );
}

export function persistedIdentifyVisitQuery(siteId: string, visitId: string) {
  const visits = scan(schema.visits);
  const identity = scalar(sitePkRelationForSiteId(siteId));
  const matching = filter(
    visits,
    and(
      eq(visits.columns.visit_id, param(visitId)),
      eq(visits.columns.site_pk, identity),
    ),
  );
  return limit(
    project(matching, {
      sessionId: matching.columns.session_id,
      visitorId: matching.columns.visitor_id,
    }),
    1,
  );
}

export function updatePersistedIdentifyMutation(input: {
  readonly siteId: string;
  readonly visitId: string;
  readonly userId: string;
  readonly userName: string | null;
}) {
  return update(schema.visits, (columns) => ({
    set: {
      user_id: input.userId,
      user_name: input.userName,
    },
    where: and(
      eq(columns.visit_id, param(input.visitId)),
      eq(columns.site_pk, scalar(sitePkRelationForSiteId(input.siteId))),
    ),
  }));
}
