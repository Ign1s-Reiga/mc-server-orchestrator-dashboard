'use client';

import type { ServerStatus } from '@/lib/api/types';
import { TONE_COLOR, absolute, age, conditionTone, sortConditions } from '@/lib/display';
import { useNow } from './fleet-provider';
import { Empty } from './ui';

const MARK: Record<string, string> = { TRUE: '■', FALSE: '□', UNKNOWN: '·' };

/**
 * The conditions block.
 *
 * `lastTransitionAt` gets its own column because API.md §7 is explicit that it
 * is what an operator actually cares about: `NEEDS_ATTENTION` being true says
 * something is wrong, but *how long it has been true* is what says whether it
 * is a blip or an outage.
 */
export function ConditionsTable({ status }: { status: ServerStatus }) {
  const now = useNow();
  const conditions = sortConditions(status.conditions);

  if (conditions.length === 0) {
    return (
      <p className="px-4 py-6 text-center">
        <Empty>no conditions recorded</Empty>
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b">
            <th className="label font-medium px-4 py-2 w-8" />
            <th className="label font-medium px-4 py-2">condition</th>
            <th className="label font-medium px-4 py-2">message</th>
            <th className="label font-medium px-4 py-2 text-right whitespace-nowrap">since</th>
          </tr>
        </thead>
        <tbody>
          {conditions.map((condition) => {
            const tone = conditionTone(condition.type, condition.status);
            const color = TONE_COLOR[tone];
            return (
              <tr key={condition.type} className="border-b last:border-b-0 align-top">
                <td className="px-4 py-2 mono text-center" style={{ color }} aria-hidden>
                  {MARK[condition.status] ?? '·'}
                </td>
                <td className="px-4 py-2">
                  <span className="mono text-[12px]" style={{ color }}>
                    {condition.type}
                  </span>
                  <span className="sr-only"> is {condition.status}</span>
                  <div className="mono text-[10px]" style={{ color: 'var(--text-faint)' }}>
                    {condition.status}
                  </div>
                </td>
                <td className="px-4 py-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
                  {condition.message.length > 0 ? condition.message : <Empty>—</Empty>}
                </td>
                <td
                  className="px-4 py-2 mono text-[12px] text-right whitespace-nowrap"
                  style={{ color: 'var(--text-faint)' }}
                  title={absolute(condition.lastTransitionAt)}
                >
                  {age(condition.lastTransitionAt, now)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
