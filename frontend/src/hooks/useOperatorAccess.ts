import { useEffect, useState } from 'react';
import { hasOperatorAccess } from '@/lib/operatorAccess';

/** null while unknown, then true/false. See lib/operatorAccess.ts. */
export function useOperatorAccess(): boolean | null {
  const [access, setAccess] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void hasOperatorAccess().then((ok) => {
      if (alive) setAccess(ok);
    });
    return () => {
      alive = false;
    };
  }, []);
  return access;
}
