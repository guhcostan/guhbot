import type { ReactElement } from 'react';
import type { ConnectionView } from '../core/device';

import { toneFromConnection } from '../theme';
import { NoticeCard } from './NoticeCard';

/**
 * Nothing is shown while the link is healthy: a permanent green strip is noise.
 * An unreachable host is a card with a retry, never a spinner, because the host
 * is not coming back on a schedule the phone can wait for.
 */
export function ConnectionBanner({ view, onRetry }: { readonly view: ConnectionView; readonly onRetry?: () => void }): ReactElement | null {
  if (view.state === 'ready' || view.state === 'unpaired') return null;
  const canRetry = onRetry !== undefined && (view.state === 'unreachable' || view.state === 'retrying');
  return (
    <NoticeCard
      tone={toneFromConnection(view.tone)}
      title={view.label}
      detail={view.hint}
      {...(canRetry ? { action: { label: 'Connect now', onPress: onRetry } } : {})}
    />
  );
}
