import { intlGetLocale, intlSetLocale, intlWatchLocale, onMount, ref, t, vm } from 'jinge';

import { registerErrors } from '../service/errors';
import Button from './Button';

const LOCALES = vm([
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
]);

export default function LanguageSwitcher() {
  const model = vm({ open: false, locale: intlGetLocale() });
  const root = ref<HTMLDivElement>();

  onMount(() => {
    const stop = intlWatchLocale((locale) => {
      model.locale = locale;
    }, true);
    const dismiss = (event: PointerEvent) => {
      if (!root.value?.contains(event.target as Node)) model.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => {
      stop();
      document.removeEventListener('pointerdown', dismiss);
    };
  });

  async function choose(locale: string) {
    model.open = false;
    if (locale === model.locale) return;
    await intlSetLocale(locale);
    try {
      localStorage.setItem('lanfly.locale', locale);
    } catch {
      // Storage may be unavailable in private browsing.
    }
    registerErrors();
    document.title = t('LanFly - 局域网聊天、文件互传、键鼠共享和远程桌面');
    document.documentElement.lang = locale;
  }

  return (
    <div ref={root} className="relative">
      <Button
        size="icon"
        className="text-neutral-90 hover:text-neutral-110"
        title={t('切换语言')}
        aria-label={t('切换语言')}
        aria-expanded={model.open}
        on:click={() => {
          model.open = !model.open;
        }}
      >
        <span className="icon-[codicon--globe] text-[15px]" aria-hidden="true" />
      </Button>
      {model.open && (
        <div className="absolute top-full right-0 z-50 mt-2 w-32 overflow-hidden rounded-control border border-neutral-60 bg-neutral-30 py-1 shadow-toolbar">
          {LOCALES.map((locale) => (
            <button
              key={locale.id}
              className={`flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-[11.5px] transition-colors hover:bg-white/5 ${
                locale.id === model.locale ? 'text-blue-40' : 'text-neutral-100'
              }`}
              on:click={() => void choose(locale.id)}
            >
              {locale.label}
              {locale.id === model.locale && (
                <span className="icon-[codicon--check] text-[12px]" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
