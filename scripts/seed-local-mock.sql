PRAGMA foreign_keys = ON;

DELETE FROM pageviews_archive_hourly
WHERE site_id IN (
  'mock-site-01',
  'mock-site-02',
  'mock-site-03',
  'mock-site-04',
  'mock-site-05',
  'mock-site-06',
  'mock-site-07',
  'mock-site-08',
  'mock-site-09',
  'mock-site-10'
);

DELETE FROM pageviews
WHERE site_id IN (
  'mock-site-01',
  'mock-site-02',
  'mock-site-03',
  'mock-site-04',
  'mock-site-05',
  'mock-site-06',
  'mock-site-07',
  'mock-site-08',
  'mock-site-09',
  'mock-site-10'
);

DELETE FROM sites
WHERE id IN (
  'mock-site-01',
  'mock-site-02',
  'mock-site-03',
  'mock-site-04',
  'mock-site-05',
  'mock-site-06',
  'mock-site-07',
  'mock-site-08',
  'mock-site-09',
  'mock-site-10'
);

WITH
mock_sites (site_ord, site_id, name, domain, public_enabled, public_slug, base_sessions) AS (
  VALUES
    (1, 'mock-site-01', 'Northstar Commerce', 'northstar-shop.com', 1, 'northstar-commerce', 42),
    (2, 'mock-site-02', 'Beacon CRM', 'beaconcrm.io', 1, 'beacon-crm', 36),
    (3, 'mock-site-03', 'Atlas Travel', 'atlas-travel.co', 1, 'atlas-travel', 32),
    (4, 'mock-site-04', 'PulseFit', 'pulsefit.app', 0, 'pulsefit', 38),
    (5, 'mock-site-05', 'LensLab Media', 'lenslab.media', 1, 'lenslab-media', 28),
    (6, 'mock-site-06', 'Summit Academy', 'summitacademy.org', 0, 'summit-academy', 34),
    (7, 'mock-site-07', 'UrbanBite Delivery', 'urbanbite.food', 1, 'urbanbite-delivery', 44),
    (8, 'mock-site-08', 'Riverbank Finance', 'riverbankpay.com', 0, 'riverbank-finance', 31),
    (9, 'mock-site-09', 'CloudNest DevTools', 'cloudnest.dev', 1, 'cloudnest-devtools', 29),
    (10, 'mock-site-10', 'GreenLeaf Home', 'greenleafhome.com', 1, 'greenleaf-home', 27)
),
selected_team AS (
  SELECT id AS team_id
  FROM teams
  ORDER BY CASE WHEN slug = 'admin-team' THEN 0 ELSE 1 END, created_at ASC
  LIMIT 1
)
INSERT INTO sites (
  id,
  team_id,
  name,
  domain,
  public_enabled,
  public_slug,
  created_at,
  updated_at
)
SELECT
  ms.site_id,
  st.team_id,
  ms.name,
  ms.domain,
  ms.public_enabled,
  CASE WHEN ms.public_enabled = 1 THEN ms.public_slug ELSE NULL END,
  unixepoch() - (45 + ms.site_ord) * 86400,
  unixepoch() - (5 + ms.site_ord) * 86400
FROM mock_sites ms
CROSS JOIN selected_team st;

WITH RECURSIVE
mock_sites (site_ord, site_id, name, domain, public_enabled, public_slug, base_sessions) AS (
  VALUES
    (1, 'mock-site-01', 'Northstar Commerce', 'northstar-shop.com', 1, 'northstar-commerce', 42),
    (2, 'mock-site-02', 'Beacon CRM', 'beaconcrm.io', 1, 'beacon-crm', 36),
    (3, 'mock-site-03', 'Atlas Travel', 'atlas-travel.co', 1, 'atlas-travel', 32),
    (4, 'mock-site-04', 'PulseFit', 'pulsefit.app', 0, 'pulsefit', 38),
    (5, 'mock-site-05', 'LensLab Media', 'lenslab.media', 1, 'lenslab-media', 28),
    (6, 'mock-site-06', 'Summit Academy', 'summitacademy.org', 0, 'summit-academy', 34),
    (7, 'mock-site-07', 'UrbanBite Delivery', 'urbanbite.food', 1, 'urbanbite-delivery', 44),
    (8, 'mock-site-08', 'Riverbank Finance', 'riverbankpay.com', 0, 'riverbank-finance', 31),
    (9, 'mock-site-09', 'CloudNest DevTools', 'cloudnest.dev', 1, 'cloudnest-devtools', 29),
    (10, 'mock-site-10', 'GreenLeaf Home', 'greenleafhome.com', 1, 'greenleaf-home', 27)
),
selected_team AS (
  SELECT id AS team_id
  FROM teams
  ORDER BY CASE WHEN slug = 'admin-team' THEN 0 ELSE 1 END, created_at ASC
  LIMIT 1
),
day_idx(day_offset) AS (
  SELECT 0
  UNION ALL
  SELECT day_offset + 1
  FROM day_idx
  WHERE day_offset < 29
),
session_idx(session_num) AS (
  SELECT 0
  UNION ALL
  SELECT session_num + 1
  FROM session_idx
  WHERE session_num < 89
),
event_idx(event_num) AS (
  SELECT 0
  UNION ALL
  SELECT event_num + 1
  FROM event_idx
  WHERE event_num < 2
),
geo_profiles (
  geo_id,
  country,
  region,
  region_code,
  city,
  continent,
  latitude,
  longitude,
  postal_code,
  metro_code,
  timezone,
  is_eu,
  as_organization
) AS (
  VALUES
    (0, 'US', 'California', 'CA', 'San Francisco', 'NA', 37.7749, -122.4194, '94107', '807', 'America/Los_Angeles', 0, 'Comcast Cable'),
    (1, 'US', 'New York', 'NY', 'New York', 'NA', 40.7128, -74.0060, '10001', '501', 'America/New_York', 0, 'Verizon Business'),
    (2, 'DE', 'Berlin', 'BE', 'Berlin', 'EU', 52.5200, 13.4050, '10115', '0', 'Europe/Berlin', 1, 'Deutsche Telekom'),
    (3, 'FR', 'Ile-de-France', 'IDF', 'Paris', 'EU', 48.8566, 2.3522, '75001', '0', 'Europe/Paris', 1, 'Orange S.A.'),
    (4, 'GB', 'England', 'ENG', 'London', 'EU', 51.5074, -0.1278, 'EC1A', '0', 'Europe/London', 0, 'BT Group'),
    (5, 'JP', 'Tokyo', '13', 'Tokyo', 'AS', 35.6762, 139.6503, '100-0001', '0', 'Asia/Tokyo', 0, 'NTT Communications'),
    (6, 'SG', 'Singapore', '01', 'Singapore', 'AS', 1.3521, 103.8198, '048616', '0', 'Asia/Singapore', 0, 'Singtel'),
    (7, 'IN', 'Karnataka', 'KA', 'Bengaluru', 'AS', 12.9716, 77.5946, '560001', '0', 'Asia/Kolkata', 0, 'Bharti Airtel'),
    (8, 'BR', 'Sao Paulo', 'SP', 'Sao Paulo', 'SA', -23.5505, -46.6333, '01000-000', '0', 'America/Sao_Paulo', 0, 'Telefonica Brasil'),
    (9, 'AU', 'New South Wales', 'NSW', 'Sydney', 'OC', -33.8688, 151.2093, '2000', '0', 'Australia/Sydney', 0, 'Telstra'),
    (10, 'CA', 'Ontario', 'ON', 'Toronto', 'NA', 43.6532, -79.3832, 'M5H', '0', 'America/Toronto', 0, 'Rogers Communications'),
    (11, 'NL', 'North Holland', 'NH', 'Amsterdam', 'EU', 52.3676, 4.9041, '1012', '0', 'Europe/Amsterdam', 1, 'KPN')
),
ua_profiles (
  ua_id,
  browser,
  browser_version,
  os,
  os_version,
  device_type,
  screen_width,
  screen_height,
  language,
  ua_raw
) AS (
  VALUES
    (0, 'Chrome', '122.0', 'Windows', '11', 'desktop', 1920, 1080, 'en-US', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'),
    (1, 'Safari', '17.3', 'macOS', '14.3', 'desktop', 1512, 982, 'en-US', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15'),
    (2, 'Safari', '17.2', 'iOS', '17.2', 'mobile', 390, 844, 'en-US', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'),
    (3, 'Chrome', '121.0', 'Android', '14', 'mobile', 412, 915, 'en-US', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.178 Mobile Safari/537.36'),
    (4, 'Edge', '122.0', 'Windows', '11', 'desktop', 1366, 768, 'en-US', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0'),
    (5, 'Firefox', '123.0', 'Linux', '6.8', 'desktop', 1440, 900, 'en-US', 'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'),
    (6, 'Chrome', '122.0', 'macOS', '14.3', 'desktop', 1728, 1117, 'en-GB', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'),
    (7, 'Samsung Internet', '25.0', 'Android', '14', 'mobile', 360, 800, 'en-US', 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36')
),
sessions AS (
  SELECT
    ms.site_id,
    ms.site_ord,
    ms.name AS site_name,
    ms.domain,
    d.day_offset,
    s.session_num,
    (ms.base_sessions + ((d.day_offset * 7 + ms.site_ord * 11) % 22) - 8) AS sessions_for_day
  FROM mock_sites ms
  CROSS JOIN day_idx d
  CROSS JOIN session_idx s
),
selected_sessions AS (
  SELECT
    site_id,
    site_ord,
    site_name,
    domain,
    day_offset,
    session_num,
    ((session_num * 7 + day_offset * 3 + site_ord) % 12) AS geo_id,
    ((session_num * 5 + day_offset * 2 + site_ord) % 8) AS ua_id
  FROM sessions
  WHERE session_num < sessions_for_day
),
events AS (
  SELECT
    ss.site_id,
    ss.site_ord,
    ss.site_name,
    ss.domain,
    ss.day_offset,
    ss.session_num,
    ss.geo_id,
    ss.ua_id,
    e.event_num,
    CASE
      WHEN ((ss.session_num + ss.day_offset + ss.site_ord) % 5) = 0 THEN 3
      ELSE 2
    END AS events_in_session
  FROM selected_sessions ss
  CROSS JOIN event_idx e
),
selected_events AS (
  SELECT
    site_id,
    site_ord,
    site_name,
    domain,
    day_offset,
    session_num,
    geo_id,
    ua_id,
    event_num
  FROM events
  WHERE event_num < events_in_session
),
resolved AS (
  SELECT
    se.site_id,
    se.site_ord,
    se.site_name,
    se.domain,
    se.day_offset,
    se.session_num,
    se.event_num,
    gp.country,
    gp.region,
    gp.region_code,
    gp.city,
    gp.continent,
    gp.latitude,
    gp.longitude,
    gp.postal_code,
    gp.metro_code,
    gp.timezone,
    gp.is_eu,
    gp.as_organization,
    up.browser,
    up.browser_version,
    up.os,
    up.os_version,
    up.device_type,
    up.screen_width,
    up.screen_height,
    up.language,
    up.ua_raw
  FROM selected_events se
  INNER JOIN geo_profiles gp ON gp.geo_id = se.geo_id
  INNER JOIN ua_profiles up ON up.ua_id = se.ua_id
),
final_rows AS (
  SELECT
    st.team_id,
    r.site_id,
    r.site_ord,
    r.site_name,
    r.domain,
    r.day_offset,
    r.session_num,
    r.event_num,
    r.country,
    r.region,
    r.region_code,
    r.city,
    r.continent,
    r.latitude,
    r.longitude,
    r.postal_code,
    r.metro_code,
    r.timezone,
    r.is_eu,
    r.as_organization,
    r.browser,
    r.browser_version,
    r.os,
    r.os_version,
    r.device_type,
    r.screen_width,
    r.screen_height,
    r.language,
    r.ua_raw,
    (
      CAST(strftime('%s', 'now', 'start of day', '-29 days', printf('+%d days', r.day_offset)) AS INTEGER) * 1000
      + ((((r.session_num * 37 + r.site_ord * 17 + r.day_offset * 11) % 840) + 360) * 60000)
      + (r.event_num * ((45 + ((r.session_num + r.site_ord) % 4) * 30) * 1000))
      + (((r.session_num * 13 + r.day_offset * 17) % 50) * 1000)
    ) AS event_at_ms,
    ((r.session_num * 3 + r.day_offset + r.site_ord) % 7) AS ref_idx,
    ((r.session_num + r.day_offset + r.site_ord) % 6) AS campaign_idx,
    ((r.session_num + r.event_num + r.day_offset) % 7) AS path_idx
  FROM resolved r
  CROSS JOIN selected_team st
)
INSERT INTO pageviews (
  id,
  team_id,
  site_id,
  event_type,
  event_at,
  received_at,
  hour_bucket,
  pathname,
  query_string,
  hash_fragment,
  title,
  hostname,
  referer,
  referer_host,
  utm_source,
  utm_medium,
  utm_campaign,
  utm_term,
  utm_content,
  visitor_id,
  session_id,
  duration_ms,
  is_eu,
  country,
  region,
  region_code,
  city,
  continent,
  latitude,
  longitude,
  postal_code,
  metro_code,
  timezone,
  as_organization,
  ua_raw,
  browser,
  browser_version,
  os,
  os_version,
  device_type,
  screen_width,
  screen_height,
  language,
  created_at
)
SELECT
  printf('mock-%s-d%02d-s%03d-e%d', fr.site_id, fr.day_offset, fr.session_num, fr.event_num) AS id,
  fr.team_id,
  fr.site_id,
  CASE
    WHEN fr.event_num = 0 THEN 'pageview'
    WHEN ((fr.session_num + fr.day_offset + fr.site_ord) % 17) = 0 THEN 'purchase'
    WHEN ((fr.session_num + fr.site_ord) % 9) = 0 THEN 'signup_submit'
    WHEN ((fr.session_num + fr.day_offset) % 4) = 0 THEN 'click_cta'
    ELSE 'scroll_75'
  END AS event_type,
  fr.event_at_ms AS event_at,
  fr.event_at_ms + 120 + ((fr.session_num * 19 + fr.event_num * 13) % 700) AS received_at,
  CAST(fr.event_at_ms / 3600000 AS INTEGER) AS hour_bucket,
  CASE fr.site_ord
    WHEN 1 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/collections/new-arrivals'
      WHEN 2 THEN '/products/smart-lamp'
      WHEN 3 THEN '/products/air-purifier'
      WHEN 4 THEN '/cart'
      WHEN 5 THEN '/checkout'
      ELSE '/blog/spring-style-guide'
    END
    WHEN 2 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/pricing'
      WHEN 2 THEN '/features/automation'
      WHEN 3 THEN '/docs/getting-started'
      WHEN 4 THEN '/customers'
      WHEN 5 THEN '/signup'
      ELSE '/blog/product-updates'
    END
    WHEN 3 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/destinations/japan'
      WHEN 2 THEN '/destinations/iceland'
      WHEN 3 THEN '/packages/weekend-city'
      WHEN 4 THEN '/deals'
      WHEN 5 THEN '/checkout'
      ELSE '/blog/travel-tips'
    END
    WHEN 4 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/plans'
      WHEN 2 THEN '/workouts/hiit-20'
      WHEN 3 THEN '/nutrition/protein-guide'
      WHEN 4 THEN '/app'
      WHEN 5 THEN '/subscribe'
      ELSE '/community'
    END
    WHEN 5 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/article/ai-agent-observability'
      WHEN 2 THEN '/article/edge-caching-patterns'
      WHEN 3 THEN '/newsletter'
      WHEN 4 THEN '/podcast/episode-12'
      WHEN 5 THEN '/about'
      ELSE '/contact'
    END
    WHEN 6 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/courses/data-analytics'
      WHEN 2 THEN '/courses/product-management'
      WHEN 3 THEN '/pricing'
      WHEN 4 THEN '/webinars'
      WHEN 5 THEN '/enroll'
      ELSE '/blog/student-stories'
    END
    WHEN 7 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/menu'
      WHEN 2 THEN '/restaurants/sushi-house'
      WHEN 3 THEN '/restaurants/burger-park'
      WHEN 4 THEN '/cart'
      WHEN 5 THEN '/checkout'
      ELSE '/offers/weeknight-deals'
    END
    WHEN 8 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/product/card'
      WHEN 2 THEN '/product/savings'
      WHEN 3 THEN '/pricing'
      WHEN 4 THEN '/security'
      WHEN 5 THEN '/signup'
      ELSE '/support'
    END
    WHEN 9 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/docs'
      WHEN 2 THEN '/docs/sdk/javascript'
      WHEN 3 THEN '/pricing'
      WHEN 4 THEN '/changelog'
      WHEN 5 THEN '/login'
      ELSE '/blog/performance-benchmark'
    END
    WHEN 10 THEN CASE fr.path_idx
      WHEN 0 THEN '/'
      WHEN 1 THEN '/collections/living-room'
      WHEN 2 THEN '/products/oak-dining-table'
      WHEN 3 THEN '/products/linen-sofa'
      WHEN 4 THEN '/cart'
      WHEN 5 THEN '/checkout'
      ELSE '/inspiration'
    END
    ELSE '/'
  END AS pathname,
  CASE fr.campaign_idx
    WHEN 0 THEN 'utm_source=google&utm_medium=cpc&utm_campaign=spring_launch'
    WHEN 1 THEN 'utm_source=linkedin&utm_medium=social&utm_campaign=thought_leadership'
    WHEN 2 THEN 'utm_source=newsletter&utm_medium=email&utm_campaign=monthly_digest'
    ELSE NULL
  END AS query_string,
  CASE
    WHEN fr.site_ord IN (2, 8, 9) AND fr.event_num = 1 AND (fr.session_num % 5) = 0 THEN 'faq'
    ELSE ''
  END AS hash_fragment,
  printf('%s | session %03d', fr.site_name, fr.session_num) AS title,
  fr.domain AS hostname,
  CASE fr.ref_idx
    WHEN 0 THEN ''
    WHEN 1 THEN 'https://www.google.com/search?q=product+analytics'
    WHEN 2 THEN 'https://www.bing.com/search?q=traffic+dashboard'
    WHEN 3 THEN 'https://www.linkedin.com/feed/'
    WHEN 4 THEN 'https://twitter.com/'
    WHEN 5 THEN 'https://github.com/trending'
    ELSE 'https://www.reddit.com/r/webdev/'
  END AS referer,
  CASE fr.ref_idx
    WHEN 0 THEN ''
    WHEN 1 THEN 'google.com'
    WHEN 2 THEN 'bing.com'
    WHEN 3 THEN 'linkedin.com'
    WHEN 4 THEN 'twitter.com'
    WHEN 5 THEN 'github.com'
    ELSE 'reddit.com'
  END AS referer_host,
  CASE fr.campaign_idx
    WHEN 0 THEN 'google'
    WHEN 1 THEN 'linkedin'
    WHEN 2 THEN 'newsletter'
    ELSE NULL
  END AS utm_source,
  CASE fr.campaign_idx
    WHEN 0 THEN 'cpc'
    WHEN 1 THEN 'social'
    WHEN 2 THEN 'email'
    ELSE NULL
  END AS utm_medium,
  CASE fr.campaign_idx
    WHEN 0 THEN 'spring_launch'
    WHEN 1 THEN 'thought_leadership'
    WHEN 2 THEN 'monthly_digest'
    ELSE NULL
  END AS utm_campaign,
  CASE
    WHEN fr.campaign_idx = 0 THEN 'analytics platform'
    ELSE NULL
  END AS utm_term,
  CASE
    WHEN fr.campaign_idx IN (0, 1, 2) THEN lower(replace(fr.site_name, ' ', '_'))
    ELSE NULL
  END AS utm_content,
  printf('%s-v%03d', fr.site_id, ((fr.session_num * 5 + fr.day_offset * 7 + fr.site_ord) % 260)) AS visitor_id,
  printf('%s-d%02d-s%03d', fr.site_id, fr.day_offset, fr.session_num) AS session_id,
  CASE
    WHEN fr.event_num = 0 AND ((fr.session_num + fr.day_offset) % 8) = 0 THEN 0
    ELSE (25 + ((fr.session_num * 13 + fr.day_offset * 7 + fr.site_ord * 3 + fr.event_num * 11) % 240)) * 1000
  END AS duration_ms,
  fr.is_eu,
  fr.country,
  fr.region,
  fr.region_code,
  fr.city,
  fr.continent,
  fr.latitude,
  fr.longitude,
  fr.postal_code,
  fr.metro_code,
  fr.timezone,
  fr.as_organization,
  fr.ua_raw,
  fr.browser,
  fr.browser_version,
  fr.os,
  fr.os_version,
  fr.device_type,
  fr.screen_width,
  fr.screen_height,
  fr.language,
  CAST(fr.event_at_ms / 1000 AS INTEGER) AS created_at
FROM final_rows fr;
