import { useState } from 'react';
import { Dices } from 'lucide-react';

interface BotAvatarProps {
  size?: 'sm' | 'md' | 'lg';
}

export function BotAvatar({ size = 'md' }: BotAvatarProps) {
  const [failed, setFailed] = useState(false);

  const dims =
    size === 'sm' ? 'w-8 h-8' : size === 'lg' ? 'w-14 h-14' : 'w-10 h-10';

  if (failed) {
    return (
      <div
        className={`${dims} rounded-full bg-emerald-900 text-amber-300 flex items-center justify-center shrink-0 border border-emerald-700`}
        aria-label="Аватар Дяди Депа"
      >
        <Dices className="w-5 h-5" />
      </div>
    );
  }

  return (
    <img
      src="/src/assets/images/dyadya_dep_avatar_1794553393202.jpg"
      alt="Дядя Деп"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${dims} rounded-full object-cover shrink-0 border border-slate-200 bg-emerald-950`}
    />
  );
}
