import { computeEditImpact, searchMediaIndex } from '../src/shared/timelineEngine';
import { converse } from './conversation';
export async function planResponse(...args: Parameters<typeof converse>) {
  const plan = await converse(...args);
  return {
    plan,
    impact: computeEditImpact(args[1], args[2], plan),
    searchHits: plan.searchQuery ? searchMediaIndex(args[2], args[1].segments, plan.searchQuery) : [],
  };
}
