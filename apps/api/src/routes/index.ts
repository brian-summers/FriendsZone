import type { AnyRoute } from '../http/route.js';
import type { Config } from '../config.js';
import type { Repositories } from '../repositories/ports.js';
import { buildAccountRoutes } from './account.js';
import { buildAuthRoutes } from './auth.js';
import { buildCalendarRoutes } from './calendar.js';
import { buildCircleRoutes } from './circles.js';
import { buildExchangeRoutes } from './exchanges.js';
import { buildHangoutRoutes } from './hangouts.js';
import { healthRoute, readyRoute } from './health.js';
import { buildListingRoutes } from './listings.js';
import { buildPeopleRoutes } from './people.js';
import { buildReportRoutes } from './reports.js';
import { buildSlotRoutes } from './slots.js';
import { buildSocialRoutes } from './social.js';

export type { AnyRoute };

/**
 * The complete route table.
 *
 * Every HTTP surface in Friendszone is reachable from this one function. That is
 * what makes "list every public endpoint" and "list every action the API can
 * perform" answerable by reading a single value — for a reviewer, for an audit,
 * and for an agent asked to change something without breaking the perimeter.
 */
export function buildRoutes(repos: Repositories, config: Config): AnyRoute[] {
  return [
    healthRoute,
    readyRoute(repos),
    ...buildAuthRoutes(repos, config),
    ...buildPeopleRoutes(repos),
    ...buildSocialRoutes(repos),
    ...buildAccountRoutes(repos),
    ...buildCircleRoutes(repos),
    ...buildCalendarRoutes(repos),
    ...buildHangoutRoutes(repos),
    ...buildListingRoutes(repos),
    ...buildExchangeRoutes(repos),
    ...buildReportRoutes(repos),
    ...buildSlotRoutes(repos),
  ];
}
