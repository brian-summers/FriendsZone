import type { AnyRoute } from '../http/route.js';
import type { Repositories } from '../repositories/ports.js';
import { buildCalendarRoutes } from './calendar.js';
import { buildHangoutRoutes } from './hangouts.js';
import { healthRoute } from './health.js';
import { buildPeopleRoutes } from './people.js';

export type { AnyRoute };

/**
 * The complete route table.
 *
 * Every HTTP surface in Friendszone is reachable from this one function. That is
 * what makes "list every public endpoint" and "list every action the API can
 * perform" answerable by reading a single value — for a reviewer, for an audit,
 * and for an agent asked to change something without breaking the perimeter.
 */
export function buildRoutes(repos: Repositories): AnyRoute[] {
  return [
    healthRoute,
    ...buildPeopleRoutes(repos),
    ...buildCalendarRoutes(repos),
    ...buildHangoutRoutes(repos),
  ];
}
