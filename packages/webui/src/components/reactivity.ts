import { nextTick, onMount, watch } from 'jinge';

/** Mount 后执行 DOM 副作用，并显式声明需要重新执行的响应式路径。 */
export function onChanges(
  callback: () => void | (() => void),
  sources: readonly (readonly [object, (string | number)[]])[],
) {
  let mounted = false;
  let pending = false;
  let cleanup: void | (() => void);
  const refresh = () => {
    cleanup?.();
    cleanup = callback();
  };
  for (const [source, path] of sources) {
    watch(
      source,
      path,
      () => {
        if (!mounted || pending) return;
        pending = true;
        void nextTick().then(() => {
          pending = false;
          if (mounted) refresh();
        });
      },
      { deep: true },
    );
  }
  onMount(() => {
    mounted = true;
    refresh();
    return () => {
      mounted = false;
      cleanup?.();
    };
  });
}
