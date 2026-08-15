import { ShieldQuestion } from 'lucide-react';

import { Reveal } from '@/shared/ui/Motion';
import type { PendingPermission } from '@/types/chat';

type PermissionBannerProps = {
  permission: PendingPermission;
  onAnswer: (requestId: string, allow: boolean, remember?: boolean) => void;
};

/**
 * The approval prompt for a tool call.
 *
 * Uses the SDK's own `title`/`description` when present — they are written for
 * exactly this surface and read better than anything derived from the raw tool
 * name and arguments.
 */
export function PermissionBanner({ permission, onAnswer }: PermissionBannerProps) {
  const heading = permission.title ?? `Allow ${permission.toolName}?`;

  return (
    <Reveal variant="rise">
      <div className="rounded-xl border border-warning/50 bg-warning/10 p-3">
        <div className="flex items-start gap-2">
          <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{heading}</p>
            {permission.description ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{permission.description}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onAnswer(permission.requestId, true)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-transform duration-instant ease-emphasis active:scale-95"
              >
                Allow once
              </button>
              <button
                type="button"
                onClick={() => onAnswer(permission.requestId, true, true)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors duration-quick hover:bg-accent"
              >
                Allow for this chat
              </button>
              <button
                type="button"
                onClick={() => onAnswer(permission.requestId, false)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors duration-quick hover:bg-destructive/10 hover:text-destructive"
              >
                Deny
              </button>
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}
