import { useEffect, useState } from 'react';
import { getBindings, KEYBINDING_EVENT, type ShortcutId } from '../core/keybindings';

/** 订阅快捷键表：设置里改完，编辑器标题与设置页自身立即跟着换。 */
export function useKeybindings(): Record<ShortcutId, string> {
  const [bindings, setBindings] = useState(getBindings);
  useEffect(() => {
    const sync = () => setBindings(getBindings());
    window.addEventListener(KEYBINDING_EVENT, sync);
    return () => window.removeEventListener(KEYBINDING_EVENT, sync);
  }, []);
  return bindings;
}
