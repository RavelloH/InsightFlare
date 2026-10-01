import {
  aggregate,
  and,
  caseWhen,
  castInteger,
  coalesce,
  compileD1Query,
  count,
  div,
  eq,
  filter,
  gte,
  isNotNull,
  lt,
  neq,
  param,
  project,
  scan,
  sort,
  sum,
  trimSpaces,
  union,
} from "@/lib/db";
import { schema } from "@/lib/db/schema";
import { ONE_HOUR_MS } from "@/lib/edge/utils";

export function buildHourlyRollupMetricRelation(
  sitePk: number,
  startHour: number,
  endHour: number,
) {
  const visitTable = scan(schema.visits);
  const visitColumns = project(visitTable, {
    sitePk: visitTable.columns.site_pk,
    startedAt: visitTable.columns.started_at,
    status: visitTable.columns.status,
    siteId: visitTable.columns.site_id,
    durationMs: visitTable.columns.duration_ms,
    perfTtfbMs: visitTable.columns.perf_ttfb_ms,
    perfFcpMs: visitTable.columns.perf_fcp_ms,
    perfLcpMs: visitTable.columns.perf_lcp_ms,
    perfCls: visitTable.columns.perf_cls,
    perfInpMs: visitTable.columns.perf_inp_ms,
    visitorId: visitTable.columns.visitor_id,
    sessionId: visitTable.columns.session_id,
  });
  const selectedVisits = filter(
    visitColumns,
    and(
      eq(visitColumns.columns.sitePk, param(sitePk)),
      gte(visitColumns.columns.startedAt, param(startHour * ONE_HOUR_MS)),
      lt(visitColumns.columns.startedAt, param((endHour + 1) * ONE_HOUR_MS)),
      neq(visitColumns.columns.status, param("open")),
    ),
  );
  const base = project(selectedVisits, {
    siteId: selectedVisits.columns.siteId,
    hourBucket: castInteger(
      div(selectedVisits.columns.startedAt, param(ONE_HOUR_MS)),
    ),
    durationMs: selectedVisits.columns.durationMs,
    perfTtfbMs: selectedVisits.columns.perfTtfbMs,
    perfFcpMs: selectedVisits.columns.perfFcpMs,
    perfLcpMs: selectedVisits.columns.perfLcpMs,
    perfCls: selectedVisits.columns.perfCls,
    perfInpMs: selectedVisits.columns.perfInpMs,
    visitorId: selectedVisits.columns.visitorId,
    sessionId: selectedVisits.columns.sessionId,
  });

  const durationIncluded = and(
    isNotNull(base.columns.durationMs),
    gte(base.columns.durationMs, param(0)),
  );
  const basicAggregate = aggregate(base, {
    groupBy: {
      siteId: base.columns.siteId,
      hourBucket: base.columns.hourBucket,
    },
    aggregates: {
      views: count(),
      durationMsSum: sum(
        caseWhen(
          [{ when: durationIncluded, then: base.columns.durationMs }],
          param(0),
        ),
      ),
      durationMsCount: sum(
        caseWhen([{ when: durationIncluded, then: param(1) }], param(0)),
      ),
      perfTtfbSum: sum(
        caseWhen(
          [
            {
              when: isNotNull(base.columns.perfTtfbMs),
              then: base.columns.perfTtfbMs,
            },
          ],
          param(0),
        ),
      ),
      perfTtfbCount: sum(
        caseWhen(
          [{ when: isNotNull(base.columns.perfTtfbMs), then: param(1) }],
          param(0),
        ),
      ),
      perfFcpSum: sum(
        caseWhen(
          [
            {
              when: isNotNull(base.columns.perfFcpMs),
              then: base.columns.perfFcpMs,
            },
          ],
          param(0),
        ),
      ),
      perfFcpCount: sum(
        caseWhen(
          [{ when: isNotNull(base.columns.perfFcpMs), then: param(1) }],
          param(0),
        ),
      ),
      perfLcpSum: sum(
        caseWhen(
          [
            {
              when: isNotNull(base.columns.perfLcpMs),
              then: base.columns.perfLcpMs,
            },
          ],
          param(0),
        ),
      ),
      perfLcpCount: sum(
        caseWhen(
          [{ when: isNotNull(base.columns.perfLcpMs), then: param(1) }],
          param(0),
        ),
      ),
      perfClsSum: sum(
        caseWhen(
          [
            {
              when: isNotNull(base.columns.perfCls),
              then: base.columns.perfCls,
            },
          ],
          param(0),
        ),
      ),
      perfClsCount: sum(
        caseWhen(
          [{ when: isNotNull(base.columns.perfCls), then: param(1) }],
          param(0),
        ),
      ),
      perfInpSum: sum(
        caseWhen(
          [
            {
              when: isNotNull(base.columns.perfInpMs),
              then: base.columns.perfInpMs,
            },
          ],
          param(0),
        ),
      ),
      perfInpCount: sum(
        caseWhen(
          [{ when: isNotNull(base.columns.perfInpMs), then: param(1) }],
          param(0),
        ),
      ),
    },
  });
  const basic = project(basicAggregate, {
    metric: param("basic"),
    siteId: basicAggregate.columns.siteId,
    hourBucket: basicAggregate.columns.hourBucket,
    views: basicAggregate.columns.views,
    durationMsSum: coalesce(basicAggregate.columns.durationMsSum, param(0)),
    durationMsCount: coalesce(basicAggregate.columns.durationMsCount, param(0)),
    perfTtfbSum: coalesce(basicAggregate.columns.perfTtfbSum, param(0)),
    perfTtfbCount: coalesce(basicAggregate.columns.perfTtfbCount, param(0)),
    perfFcpSum: coalesce(basicAggregate.columns.perfFcpSum, param(0)),
    perfFcpCount: coalesce(basicAggregate.columns.perfFcpCount, param(0)),
    perfLcpSum: coalesce(basicAggregate.columns.perfLcpSum, param(0)),
    perfLcpCount: coalesce(basicAggregate.columns.perfLcpCount, param(0)),
    perfClsSum: coalesce(basicAggregate.columns.perfClsSum, param(0)),
    perfClsCount: coalesce(basicAggregate.columns.perfClsCount, param(0)),
    perfInpSum: coalesce(basicAggregate.columns.perfInpSum, param(0)),
    perfInpCount: coalesce(basicAggregate.columns.perfInpCount, param(0)),
    visitorId: param(null),
    sessionId: param(null),
    visitCount: param(null),
  });

  const visitorVisits = filter(
    base,
    neq(trimSpaces(coalesce(base.columns.visitorId, param(""))), param("")),
  );
  const visitorAggregate = aggregate(visitorVisits, {
    groupBy: {
      siteId: visitorVisits.columns.siteId,
      hourBucket: visitorVisits.columns.hourBucket,
      visitorId: visitorVisits.columns.visitorId,
    },
    aggregates: {},
  });
  const visitors = project(visitorAggregate, {
    metric: param("visitor"),
    siteId: visitorAggregate.columns.siteId,
    hourBucket: visitorAggregate.columns.hourBucket,
    views: param(null),
    durationMsSum: param(null),
    durationMsCount: param(null),
    perfTtfbSum: param(null),
    perfTtfbCount: param(null),
    perfFcpSum: param(null),
    perfFcpCount: param(null),
    perfLcpSum: param(null),
    perfLcpCount: param(null),
    perfClsSum: param(null),
    perfClsCount: param(null),
    perfInpSum: param(null),
    perfInpCount: param(null),
    visitorId: visitorAggregate.columns.visitorId,
    sessionId: param(null),
    visitCount: param(null),
  });

  const sessionVisits = filter(
    base,
    neq(trimSpaces(coalesce(base.columns.sessionId, param(""))), param("")),
  );
  const sessionAggregate = aggregate(sessionVisits, {
    groupBy: {
      siteId: sessionVisits.columns.siteId,
      hourBucket: sessionVisits.columns.hourBucket,
      sessionId: sessionVisits.columns.sessionId,
    },
    aggregates: { visitCount: count() },
  });
  const sessions = project(sessionAggregate, {
    metric: param("session"),
    siteId: sessionAggregate.columns.siteId,
    hourBucket: sessionAggregate.columns.hourBucket,
    views: param(null),
    durationMsSum: param(null),
    durationMsCount: param(null),
    perfTtfbSum: param(null),
    perfTtfbCount: param(null),
    perfFcpSum: param(null),
    perfFcpCount: param(null),
    perfLcpSum: param(null),
    perfLcpCount: param(null),
    perfClsSum: param(null),
    perfClsCount: param(null),
    perfInpSum: param(null),
    perfInpCount: param(null),
    visitorId: param(null),
    sessionId: sessionAggregate.columns.sessionId,
    visitCount: sessionAggregate.columns.visitCount,
  });

  const combined = union(union(basic, visitors, true), sessions, true);
  return sort(combined, [
    { expression: combined.columns.metric, direction: "ASC" },
    { expression: combined.columns.hourBucket, direction: "ASC" },
    { expression: combined.columns.visitorId, direction: "ASC" },
    { expression: combined.columns.sessionId, direction: "ASC" },
  ]);
}

export function buildHourlyRollupMetricPlan(
  sitePk: number,
  startHour: number,
  endHour: number,
) {
  return compileD1Query(
    buildHourlyRollupMetricRelation(sitePk, startHour, endHour),
    { tag: "scheduled-tasks.visits.all" },
  );
}
